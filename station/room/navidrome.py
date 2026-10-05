"""navidrome.py: поток к файлу трека из Navidrome.

subsonic.py — сверка заказа (поиск, json на входе, json на выходе). Этот
модуль отдаёт файл: другая форма ответа (непрочитанный поток, а не json),
свой таймаут и свой разбор ошибки — конверт Subsonic, который Navidrome
шлёт с кодом HTTP 200.
"""
import hashlib
import json
import secrets
import urllib.parse
import urllib.request

# Поиск и скачивание живут в разном времени: поиск — один короткий запрос,
# скачивание — перелив 8-14 МБ, и таймаут там стоит на каждой порции чтения.
DOWNLOAD_TIMEOUT = 30


def _auth_params(user: str, password: str) -> dict:
    """Общий для всех вызовов рецепт Subsonic: соль и `md5(pass + salt)`.

    Пароль в адрес не попадает никогда. Тот же рецепт живёт в subsonic.py
    (внутри resolve()) — оба должны совпадать дословно.
    """
    salt = secrets.token_hex(8)
    return {"u": user,
            "t": hashlib.md5((password + salt).encode("utf-8")).hexdigest(),
            "s": salt, "v": "1.16.1", "c": "subwave-room", "f": "json"}


def download(track_id: str, base: str, user: str, password: str,
             rng: str | None = None, timeout: float = DOWNLOAD_TIMEOUT,
             if_range: str | None = None):
    """Открыть поток к файлу. Тело **не читается** — его переливает вызывающий.

    `rest/download` отдаёт файл как есть, без перекодирования, и в отличие от
    `rest/stream` шлёт `Content-Disposition` — единственный источник, из
    которого берётся расширение.

    `Range` пробрасывается как есть: Navidrome отвечает честным `206`, и
    `urlopen` в исключение его не превращает. `If-Range` идёт вместе с ним:
    `Last-Modified` слушатель от нас получает, и браузер докачивает с этим
    условием. Без него Navidrome отдал бы кусок уже изменившегося файла, и
    докачка молча склеила бы два разных файла; с ним он сам сверит дату и
    при расхождении отдаст файл целиком.
    """
    params = urllib.parse.urlencode({"id": track_id, **_auth_params(user, password)})
    url = f"{base.rstrip('/')}/rest/download?{params}"
    headers = {"Range": rng} if rng else {}
    if if_range:
        headers["If-Range"] = if_range
    req = urllib.request.Request(url, headers=headers)
    return urllib.request.urlopen(req, timeout=timeout)


def envelope_code(body: bytes) -> int | None:
    """Код ошибки из конверта Subsonic, если тело — конверт, а не файл.

    Navidrome отвечает на несуществующий идентификатор **кодом 200** и телом
    `{"subsonic-response":{"status":"failed","error":{"code":70}}}`, а на
    негодную учётку — тем же с кодом 40. Исключения не будет, поэтому
    различать приходится по телу.
    """
    try:
        payload = json.loads(body.decode("utf-8", "replace"))
    except (ValueError, AttributeError):
        return None
    if not isinstance(payload, dict):
        return None
    error = ((payload.get("subsonic-response") or {}).get("error") or {})
    code = error.get("code")
    return code if isinstance(code, int) else None
