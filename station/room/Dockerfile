# Контекст сборки — этот каталог:
#   docker build -t subwave-room:2 station/room
# normalize.py — своя копия комнаты: до выделения проекта она бралась из
# music/normalize.py. Расхождение с той копией безопасно — комната сверяет
# запрос слушателя с Navidrome, а не с каталогом проекта коллекции.
FROM python:3.13-alpine

# Единственная зависимость вне стандартной библиотеки — криптография Web Push
# (push.py). Версия приколочена: подпись и шифрование проверены тестом на ней,
# а сюрприз от новой версии пришёл бы молча отброшенными уведомлениями.
RUN pip install --no-cache-dir cryptography==46.0.3

WORKDIR /app
COPY guard.py store.py subsonic.py naming.py station.py navidrome.py \
     push.py notify.py admin.py dislikes.py normalize.py server.py ./

# База — на томе; путь по умолчанию совпадает с точкой монтирования в compose.
ENV ROOM_DB=/data/room.db PORT=8080
VOLUME ["/data"]
EXPOSE 8080
CMD ["python", "-u", "server.py"]
