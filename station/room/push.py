"""Web Push из комнаты: уведомление о важном в чате при закрытой вкладке.

Системное уведомление страницы (`web/lib/roomNotify.ts`) живёт, пока жива
вкладка; закрытую вкладку разбудить может только push-сервис браузера. Три
стандарта: RFC 8030 (доставка), RFC 8291 (шифрование `aes128gcm`), RFC 8292
(VAPID — подпись сервера).

Криптография — пакет `cryptography`, единственная зависимость комнаты вне
стандартной библиотеки. ECDH на P-256, HKDF, AES-128-GCM и подпись ES256
руками — это несколько сотен строк кода, ошибку в которых увидит только
push-сервис, молча отбросив сообщение. Шифрование сверяется в тесте с
примером из приложения A RFC 8291 байт в байт.
"""
import base64
import json
import os
import struct
import time
import urllib.error
import urllib.parse
import urllib.request

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

RECORD_SIZE = 4096
# Одна запись: полезная нагрузка + разделитель + тег AES-GCM обязаны влезть в
# RECORD_SIZE. Реплика чата — сотни байт, но проверка дешевле загадки «почему
# push-сервис ответил 413».
MAX_PLAINTEXT = RECORD_SIZE - 16 - 1 - 86
TTL_SEC = 3600        # телефон вне сети дольше часа — новость уже не новость
TIMEOUT_SEC = 10
JWT_LIFETIME_SEC = 12 * 3600   # RFC 8292: не больше суток
# Куда комната согласна слать. Адрес подписки приходит от браузера, то есть
# от кого угодно снаружи, и без белого списка комната стала бы прокси для
# POST-запросов в LAN (SSRF). Суффиксы — push-сервисы Chrome/Edge на Android и
# десктопе, Firefox, Safari и старого Edge.
PUSH_HOSTS = ("fcm.googleapis.com", "android.googleapis.com",
              "push.services.mozilla.com", "push.apple.com", "notify.windows.com")
ENDPOINT_MAX = 1024


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def unb64u(text: str) -> bytes:
    text = "".join(str(text).split())
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _point(key: ec.EllipticCurvePublicKey) -> bytes:
    return key.public_bytes(serialization.Encoding.X962,
                            serialization.PublicFormat.UncompressedPoint)


def _hkdf(salt: bytes, info: bytes, length: int, ikm: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt, info=info).derive(ikm)


def encrypt(plaintext: bytes, p256dh: str, auth: str, *, salt: bytes | None = None,
            server_key: ec.EllipticCurvePrivateKey | None = None) -> bytes:
    """Тело push-сообщения по RFC 8291 (`Content-Encoding: aes128gcm`).

    `salt` и `server_key` задаются только тестом: в работе оба свежие на
    каждое сообщение, иначе два сообщения одному адресату шифруются одним
    ключом с одним nonce.
    """
    if len(plaintext) > MAX_PLAINTEXT:
        raise ValueError(f"нагрузка {len(plaintext)} байт больше {MAX_PLAINTEXT}")
    ua_public = unb64u(p256dh)
    auth_secret = unb64u(auth)
    as_private = server_key or ec.generate_private_key(ec.SECP256R1())
    as_public = _point(as_private.public_key())
    ua_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public)
    ecdh_secret = as_private.exchange(ec.ECDH(), ua_key)
    ikm = _hkdf(auth_secret, b"WebPush: info\x00" + ua_public + as_public, 32, ecdh_secret)
    salt = salt or os.urandom(16)
    cek = _hkdf(salt, b"Content-Encoding: aes128gcm\x00", 16, ikm)
    nonce = _hkdf(salt, b"Content-Encoding: nonce\x00", 12, ikm)
    # 0x02 — разделитель последней (и единственной) записи, без добивки
    ciphertext = AESGCM(cek).encrypt(nonce, plaintext + b"\x02", None)
    header = salt + struct.pack("!I", RECORD_SIZE) + bytes([len(as_public)]) + as_public
    return header + ciphertext


class Vapid:
    """Ключ сервера для VAPID. Один на комнату и на всё время её жизни:
    подписка браузера привязана к открытому ключу, и новый ключ молча
    обесценил бы все подписки разом."""

    def __init__(self, private_key: ec.EllipticCurvePrivateKey):
        self.private_key = private_key
        self.public_key = b64u(_point(private_key.public_key()))

    @classmethod
    def load_or_create(cls, path: str) -> "Vapid":
        if os.path.exists(path):
            with open(path, "rb") as fh:
                return cls(serialization.load_pem_private_key(fh.read(), password=None))
        key = ec.generate_private_key(ec.SECP256R1())
        pem = key.private_bytes(serialization.Encoding.PEM,
                                serialization.PrivateFormat.PKCS8,
                                serialization.NoEncryption())
        # 0600 с первой записи, а не chmod после: ключ не должен и мгновения
        # лежать читаемым для всех
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as fh:
            fh.write(pem)
        return cls(key)

    def authorization(self, endpoint: str, subject: str, now: float) -> str:
        """Заголовок `Authorization: vapid t=<JWT>, k=<ключ>` (RFC 8292)."""
        parts = urllib.parse.urlsplit(endpoint)
        claims = {"aud": f"{parts.scheme}://{parts.netloc}",
                  "exp": int(now) + JWT_LIFETIME_SEC, "sub": subject}
        head = b64u(json.dumps({"typ": "JWT", "alg": "ES256"}, separators=(",", ":")).encode())
        body = b64u(json.dumps(claims, separators=(",", ":")).encode())
        signing_input = f"{head}.{body}".encode("ascii")
        r, s = decode_dss_signature(self.private_key.sign(signing_input,
                                                          ec.ECDSA(hashes.SHA256())))
        signature = b64u(r.to_bytes(32, "big") + s.to_bytes(32, "big"))
        return f"vapid t={head}.{body}.{signature}, k={self.public_key}"


def check_subscription(raw) -> tuple[dict | None, str | None]:
    """`(подписка, None)` либо `(None, причина отказа)`.

    Подписку присылает браузер, но проверять её надо как присланное кем угодно:
    по адресу комната потом сама ходит POST-ом.
    """
    if not isinstance(raw, dict):
        return None, "подписка должна быть объектом"
    endpoint = raw.get("endpoint")
    keys = raw.get("keys") if isinstance(raw.get("keys"), dict) else {}
    if not isinstance(endpoint, str) or len(endpoint) > ENDPOINT_MAX:
        return None, "нет адреса подписки"
    parts = urllib.parse.urlsplit(endpoint)
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or not any(host == h or host.endswith("." + h)
                                          for h in PUSH_HOSTS):
        return None, "адрес подписки — не push-сервис браузера"
    try:
        p256dh, auth = unb64u(keys.get("p256dh", "")), unb64u(keys.get("auth", ""))
    except (ValueError, TypeError):
        return None, "ключи подписки не в base64url"
    if len(p256dh) != 65 or p256dh[0] != 4 or len(auth) != 16:
        return None, "ключи подписки неверной длины"
    return {"endpoint": endpoint, "p256dh": b64u(p256dh), "auth": b64u(auth)}, None


def send(subscription: dict, payload: dict, vapid: Vapid, subject: str,
         now: float | None = None, opener=urllib.request.urlopen) -> int:
    """Отправить одно сообщение. Возвращает HTTP-код push-сервиса.

    201 — принято; 404 и 410 — подписки больше нет, её надо забыть; прочее —
    временный отказ. Сетевой сбой возвращается кодом 0, а не исключением:
    рассылка по списку не должна обрываться на первом недоступном адресате.
    """
    body = encrypt(json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                   subscription["p256dh"], subscription["auth"])
    req = urllib.request.Request(subscription["endpoint"], data=body, method="POST", headers={
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "aes128gcm",
        "TTL": str(TTL_SEC),
        "Urgency": "normal",
        # Непрочитанное одного чата схлопывается и у push-сервиса: телефон,
        # вернувшийся в сеть, получит последнее, а не пачку.
        "Topic": "subwave-chat",
        "Authorization": vapid.authorization(subscription["endpoint"], subject,
                                             time.time() if now is None else now),
    })
    try:
        with opener(req, timeout=TIMEOUT_SEC) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except (urllib.error.URLError, OSError, TimeoutError):
        return 0
