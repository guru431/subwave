r"""Аудит ударений на настоящих репликах ведущей: где RUAccent может ошибиться.

Сначала эталон — реплики эфира, на которых ударения уже были неверны; любой
промах — код выхода 1. Затем по каждому слову корпуса — откуда знак: словарь,
нейросеть (слова нет в словаре) или модель омографов; слова из двух и больше
гласных без знака; остаток — латиница и цифры, которые дошли бы до F5 и после
словаря коллекции, и после чисел словами: их F5 прочтёт по русским правилам, это
кандидаты в tools/pronunciation-extra.json. Повторять после каждой правки ударений
(f5_accent: поправки, омографы, фразы) — и до выкатки образа.

    stress_audit.py <corpus.json> [workdir]

corpus.json — список строк, реплики ведущей: его собирает tools/stress_corpus.py на
Debian, отдельную реплику берут из `docker logs sub-wave-controller`. workdir —
модели RUAccent и dictionary\accents.sqlite, по умолчанию `ruaccent` в каталоге
службы (рядом с `app`, где лежит этот `tools`).
Запускать на хосте gpu-host в венве с ruaccent и num2words (D:\Temp\f5-probe\venv);
модули службы (f5_accent, f5_service, f5_text) берутся из каталога над tools — копию
до выкатки можно проверить где угодно. Словарь коллекции — тот же, что у службы:
F5_PRONUNCIATION, без неё — pronunciation.json рядом с f5_text.
"""
import collections
import json
import re
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import f5_text  # noqa: E402
from f5_accent import Accentizer  # noqa: E402
from f5_service import before_accent  # noqa: E402

# Реплики эфира 23.09 и слова, которые в них звучали неверно, — в верном виде.
GOLDEN = [
    # softmax пакета в RUAccent — «дорог+а»
    ("Слово «родина» у каждого своё — у кого-то дом, у кого-то дорога из офиса.", "дор+ога"),
    # модель омографов tiny2.1
    ("Тихий поздний час, а радио всё работает — Ведущая на связи.", "св+язи"),
    ("Без четверти восемь — и «А может быть ворона» ложится в комнату неспешно, "
     "как раз под размеренный темп осеннего вечера.", "вор+она"),
    ("Вы слушаете домашнее радио с Ведущей — середина утра, среда, и всё идёт своим "
     "чередом.", "+утра"),
    # омограф с заглавной буквы шёл мимо модели
    ("Сентябрьское солнце уже не печёт, а лишь греет спину — самое время для Сектора "
     "Газа.", "С+ектора"),
    ("Кому-то из нас ещё допивать чай перед сном, а кому-то — досматривать последний "
     "рабочий чат.", "Ком+у-то"),
    ("За окном фонарь качает мокрую листву — как раз под стать Тони Брэкстон.", "Т+они"),
    ("После всей этой ночной драмы пора выдохнуть.", "П+осле"),
    ("Позднее сентябрьское утро, вторая половина дня на подходе.", "П+озднее"),
    # модель ё-омографов
    ("До без четверти два ещё далеко, а эта песня — как раз про то, как глаза говорят "
     "громче слов.", "далек+о"),
    ("На небе ни облака, и вечер тихий.", "н+ебе", "+облака"),
    ("Все пришли, и всё было хорошо.", "Вс+е"),
    ("Оконный свет стал медовым и низким — самое время для чего-то тёплого.", "с+амое"),
    # закреплённые омографы и поправки словаря
    ("Только что пробил час ночи, если кто-то ещё считает.", "проб+ил"),
    ("Только что пробило полночь — понедельник позади, вторник начался.",
     "проб+ило", "началс+я"),
    ("Женя Барс — «Любить до слёз».", "Ж+еня"),
    ("Глушите уведомления на пару минут.", "Глуш+ите"),
    ("Metallica подсказывает, куда её девать: в ритм.", "Мет+аллика"),
    # фразы, в которых ошибается и turbo3.1
    ("Руки Вверх!, «18 мне уже».", "Р+уки Вв+ерх"),
    ("В чашке уже вторая половина дня остыла, а допить руки так и не дошли.", "р+уки"),
    ("За окном — ровный осенний свет, ни тени, ни облака.", "+облака"),
    ("Позади уже вторая половина утра — с вами «Ведущая», домашнее радио.", "+утра"),
]

VOWELS = set("аеёиоуыэюя")
SERVICE = Path(__file__).resolve().parents[2]          # <каталог службы>\app\tools
acc = Accentizer(Path(sys.argv[2]) if len(sys.argv) > 2 else SERVICE / "ruaccent")
acc.load()
m = acc._model

misses = 0
for text, *expected in GOLDEN:
    marked = acc.apply(before_accent(text))
    lost = [e for e in expected if not re.search(rf"(?<![\w+]){re.escape(e)}(?![\w+])", marked)]
    if lost:
        misses += 1
        print(f"ЭТАЛОН: нет {', '.join(lost)} | {marked}")
print(f"эталон: {len(GOLDEN) - misses} из {len(GOLDEN)}")

with open(sys.argv[1], encoding="utf-8") as f:
    texts = json.load(f)
missing, nn, omo, rest = collections.Counter(), {}, collections.Counter(), collections.Counter()
total = 0
for t in texts:
    marked = acc.apply(before_accent(t))
    for w in re.findall(r"[А-Яа-яЁё+\-]+", marked):
        plain = w.replace("+", "").lower().strip("-")
        if not plain:
            continue
        total += 1
        vowels = sum(ch in VOWELS for ch in plain)
        if vowels >= 2 and "+" not in w and "ё" not in plain:
            missing[plain] += 1
        elif "+" in w and plain not in m.accents and plain not in m.omographs:
            nn[plain] = w.lower()
        if plain in m.omographs:
            omo[f"{plain} → {w.lower()}"] += 1
    # до словаря коллекции латиницы много, а важно, что от неё осталось после
    for w in f5_text.leftovers(f5_text.cyrillize(marked)):
        rest[w] += 1

print(f"\nреплик {len(texts)}, русских слов {total}")
print(f"\nБЕЗ ЗНАКА (≥2 гласных, без ё): {sum(missing.values())}")
for w, c in missing.most_common(40):
    print(f"  {w} ×{c}")
print(f"\nНЕЙРОСЕТЬ (слова нет в словаре): {len(nn)}")
for w in sorted(nn):
    print(f"  {nn[w]}")
print(f"\nОМОГРАФЫ: {len(omo)}")
for w, c in omo.most_common():
    print(f"  {w} ×{c}")
print(f"\nОСТАТОК после словаря и чисел (латиница и цифры, F5 прочтёт сам): {len(rest)} разных")
print("  " + ", ".join(f"{w}×{c}" if c > 1 else w for w, c in rest.most_common()))
sys.exit(1 if misses else 0)
