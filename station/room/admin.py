"""Пароль владельца станции проверяет контроллер, а не комната.

Своего пароля у комнаты нет: заголовок `Authorization` пересылается в
`GET /settings` контроллера — тем же запросом админка проверяет вход
(`web/lib/adminAuth.ts::signIn`). Пароль живёт в одном месте, а перебирать его
через комнату бесполезно: после 10 неудач подряд `requireAdmin` контроллера
закрывает вход адресу на 15 минут, и адрес здесь — адрес комнаты.

Ответ — код для владельца и `Retry-After`, если контроллер его прислал.
`WWW-Authenticate` здесь не рождается нигде: на него браузер поднял бы поверх
админки своё окно входа.
"""
import http.client
import urllib.error
import urllib.request

TIMEOUT = 10


def verify(authorization: str | None, controller_url: str,
           timeout: float = TIMEOUT) -> tuple[int, str | None]:
    """`(200, None)` — владелец; 401 — пароля нет или он неверный; 429 —
    контроллер заблокировал вход; 502 — спросить не удалось."""
    if not authorization:
        return 401, None                 # без заголовка контроллер не спрашиваем
    if not controller_url:
        return 502, None
    try:
        req = urllib.request.Request(controller_url.rstrip("/") + "/settings",
                                     headers={"Authorization": authorization})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return (200, None) if r.status == 200 else (502, None)
    except urllib.error.HTTPError as e:
        if e.code == 401:
            return 401, None
        if e.code == 429:
            return 429, e.headers.get("Retry-After") if e.headers else None
        return 502, None
    except (OSError, ValueError, http.client.HTTPException):
        return 502, None
