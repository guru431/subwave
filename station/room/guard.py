"""Чистка и проверка того, что слушатель прислал в комнату.

Текст сообщения уходит в промпт ведущего ровно так же, как текст заказа, —
значит и защищать его надо тем же. Состав правил перенесён из
`sanitizeRequestText` (`controller/src/routes/request.ts` апстрима): роль-маркеры
шаблонов чата, любые теги, поддельные начала реплик, семейство «игнорируй
предыдущие инструкции» и двойные кавычки, которыми текст вырывается из рамки
`"${text}"`. Это пояс, а не единственный слой: обрамление промпта всё равно
обращается с текстом как с данными.

Обрезка тут не делается нигде. Слишком длинное сообщение отвергается: обрезка
режет фразу на полуслове, и ведущий отвечает на половину вопроса.
"""
import re

# Те же цифры, что у заказа (REQUEST_TEXT_MAX / REQUEST_NAME_MAX в
# controller/src/schemas/request.ts): два поля одного плеера не должны жить по
# разным правилам.
TEXT_MAX = 280
NAME_MAX = 40
# Подпись, под которой сообщение уйдёт в эфир, если слушатель не назвался.
ANON_NAME = "гость"

_ROLE_TOKENS = re.compile(r"\[/?INST\]|<</?SYS>>|<\|[^|>]*\|>", re.IGNORECASE)
_TAGS = re.compile(r"</?[a-z][^>]*>", re.IGNORECASE)
_ROLE_LINE = re.compile(r"^[ \t]*(system|assistant|developer)\s*:",
                        re.IGNORECASE | re.MULTILINE)
_OVERRIDE = re.compile(
    r"\b(ignore|disregard|forget|override)\b[^.!?\n]*"
    r"\b(previous|prior|above|earlier|all)\b[^.!?\n]*\binstructions?\b",
    re.IGNORECASE)
_SPACES = re.compile(r"\s+")


def sanitize(raw: str) -> str:
    """Обезвредить разметку, которой слушатель мог бы командовать ведущим."""
    text = "" if raw is None else str(raw)
    text = _ROLE_TOKENS.sub(" ", text)
    text = _TAGS.sub(" ", text)
    text = _ROLE_LINE.sub(" ", text)
    text = _OVERRIDE.sub(" ", text)
    text = text.replace('"', "'")
    return _SPACES.sub(" ", text).strip()


def validate(text, name) -> tuple[tuple[str, str] | None, str | None]:
    """`((text, name), None)` либо `(None, причина отказа)`.

    Проверка идёт ПОСЛЕ чистки: сообщение из одной разметки после неё пусто, и
    пускать его в ленту незачем.
    """
    if not isinstance(text, str):
        return None, "поле text обязательно и должно быть строкой"
    clean = sanitize(text)
    if not clean:
        return None, "пустое сообщение"
    if len(clean) > TEXT_MAX:
        return None, f"сообщение длиннее {TEXT_MAX} символов"
    if name is None or name == "":
        who = ANON_NAME
    elif not isinstance(name, str):
        return None, "имя должно быть строкой"
    else:
        who = sanitize(name)
        if len(who) > NAME_MAX:
            return None, f"имя длиннее {NAME_MAX} символов"
        if not who:
            who = ANON_NAME
    return (clean, who), None
