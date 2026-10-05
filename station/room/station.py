"""Живое окно станции: что звучит сейчас и что уже прозвучало.

Комната спрашивает контроллер на **каждый** запрос скачивания и ответ не
кэширует. Окно живёт минутами, а кэш сделал бы отказ для уехавшего трека
недостижимым — то есть ровно ту границу, ради которой ручка и заведена.

Внутри сети стека у контроллера нет префикса `/api`: его снимает
`handle_path /api/*` в Caddy, поэтому запрашивается `/state`.

Отдаётся **отображение**, а не множество идентификаторов: из этих же данных
собирается имя файла (`artist`, `title`), и множество их потеряло бы.
"""
import json
import urllib.request

TIMEOUT = 10


def window(base: str, timeout: float = TIMEOUT) -> dict[str, dict]:
    """`subsonic_id → {"artist", "title", "album"}` для текущего трека и всей истории.

    Альбом нужен дизлайкам: по нему админка отсеивает треки заблокированных
    альбомов.

    `upcoming` не входит: трек, который ещё не звучал, не «прозвучавший».

    Пустое окно (молчащая станция, `current == null`) — законный ответ,
    означающий «скачивать нечего». Неразобранный ответ — исключение:
    «нельзя» и «не смог спросить» разные вещи, и вызывающий отвечает на них
    по-разному.
    """
    if not base:
        raise RuntimeError("адрес контроллера не задан (CONTROLLER_URL)")
    url = base.rstrip("/") + "/state"
    with urllib.request.urlopen(url, timeout=timeout) as r:
        raw = r.read()
    try:
        state = json.loads(raw.decode("utf-8", "replace"))
    except ValueError as e:
        raise ValueError(f"состояние станции не разобралось: {e}") from e
    if not isinstance(state, dict):
        raise ValueError("состояние станции — не объект JSON")

    out: dict[str, dict] = {}
    items = [state.get("current")] + list(state.get("history") or [])
    for item in items:
        if not isinstance(item, dict):
            continue
        sid = item.get("subsonic_id")
        if not sid:
            continue
        # История идёт новейшим вперёд, поэтому при повторе трека выигрывает
        # свежая запись — та, чьё имя слушатель и видит на экране.
        out.setdefault(sid, {"artist": item.get("artist"), "title": item.get("title"),
                             "album": item.get("album")})
    return out
