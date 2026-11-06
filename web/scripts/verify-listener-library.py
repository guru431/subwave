"""Manual browser regressions for local metadata, receipts and request hints.

Run against the isolated web dev server on 127.0.0.1:7793. All listener API
responses are synthetic. Each check has a 10-second timeout; no live writes.
Usage: python web/scripts/verify-listener-library.py [artifact-directory]
"""
import json
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect, sync_playwright
expect.set_options(timeout=10_000)

WEB = "http://127.0.0.1:7793/listen"
REQUEST_ID = "11111111-1111-4111-8111-111111111111"
TRACK = {"subsonic_id": "current", "title": "Песня А", "artist": "Кино", "album": "Альбом", "duration": 240}


def check(browser_type, width, artifacts):
    browser = browser_type.launch()
    context = browser.new_context(viewport={"width": width, "height": 850}, service_workers="block")
    page = context.new_page()
    page.set_default_timeout(10_000)
    phase, posted, errors = ["queued"], [], []
    page.on("pageerror", lambda e: errors.append(str(e)))

    def api(route):
        path = urlsplit(route.request.url).path
        body, status = {}, 200
        if path.endswith("/now-playing"):
            body = {"nowPlaying": TRACK, "streamOnline": True, "stream": {"bufferSeconds": 0}, "dj": {"name": "Ведущая", "station": "Тест"}}
        elif path.endswith("/state"):
            body = {"current": TRACK, "upcoming": [], "djLog": [], "history": [{**TRACK, "subsonic_id": "history", "title": "Песня из истории", "t": "2026-11-01T12:00:00Z"}],
                    "timezone": "Europe/Moscow", "ui": {"skin": "classic", "tuneInOverlay": False}}
        elif path.endswith("/session"):
            body = {"messages": [], "session": None}
        elif path.endswith("/onboarding/status"):
            body = {"needsSetup": False}
        elif path.endswith("/request") and route.request.method == "POST":
            posted.append(route.request.post_data_json)
            body, status = {"success": True, "requestId": REQUEST_ID, "status": "pending"}, 202
        elif "/request/" in path:
            body = {"success": True, "status": "resolved", "phase": phase[0], "track": {"title": "Новая песня", "artist": "Группа"}, "queuePosition": 2, "estimatedWaitSec": 180}
        elif path.endswith("/resolve"):
            query = parse_qs(urlsplit(route.request.url).query).get("q", [""])[0]
            if query.startswith("Beta"):
                body, status = {"error": "rate limited"}, 429
            elif query.startswith("Gamma"):
                body, status = {"error": "unavailable"}, 502
            else:
                body = {"exact": {"id": "relocated", "artist": "Кино", "title": "Песня А", "album": "Другой альбом", "year": 2000}, "alternatives": []}
        elif path.startswith("/room/"):
            body = {"messages": [], "last": 0, "marks": {}}
        elif path.endswith("/themes"):
            route.continue_()
            return
        route.fulfill(status=status, content_type="application/json", body=json.dumps(body, ensure_ascii=False))

    page.route("http://localhost:7791/**", api)
    page.route("**/room/**", api)
    try:
        page.goto(WEB)
        page.get_by_role("button", name="Сохранить себе", exact=True).click()
        page.reload()
        expect(page.get_by_role("button", name="Удалить из личных закладок", exact=True)).to_be_visible()
        page.keyboard.press("1")
        page.locator("summary").filter(has_text="Мои закладки").click()
        with page.expect_download() as download:
            page.get_by_role("button", name="Экспорт JSON", exact=True).click()
        exported = json.loads(Path(download.value.path()).read_text(encoding="utf-8"))
        assert exported[0]["artist"] == "Кино" and exported[0]["album"] == "Альбом"
        page.get_by_role("button", name="Сохранить себе", exact=True).last.click()
        page.wait_for_function("JSON.parse(localStorage.getItem('subwave-bookmarks-v1')).length === 2")
        page.get_by_role("button", name="Найти и заказать", exact=True).last.click()
        expect(page.get_by_text("Запись из закладки не подтверждена.", exact=False)).to_be_visible()
        expect(page.get_by_text("Нашёл в коллекции:", exact=False)).not_to_be_visible()
        textarea = page.locator("textarea").first
        textarea.fill("Alpha")
        expect(page.get_by_text("Нашёл в коллекции:", exact=False)).to_be_visible()
        textarea.fill("Beta")
        expect(page.get_by_text("Нашёл в коллекции:", exact=False)).not_to_be_visible()
        page.wait_for_timeout(500)
        textarea.fill("Alpha again")
        expect(page.get_by_text("Нашёл в коллекции:", exact=False)).to_be_visible()
        textarea.fill("Gamma")
        expect(page.get_by_text("Нашёл в коллекции:", exact=False)).not_to_be_visible()
        page.wait_for_timeout(500)
        page.get_by_role("button", name="Отправить в студию", exact=True).click()
        page.wait_for_function("JSON.parse(localStorage.getItem('subwave-receipts-v1') || '[]').length === 1")
        assert posted[-1]["text"] == "Gamma" and not posted[-1].get("songId")
        page.reload()
        expect(page.get_by_role("button", name="Удалить из личных закладок", exact=True)).to_be_visible()
        page.get_by_role("button", name="+ Заказ", exact=True).click()
        expect(page.get_by_text("В очереди", exact=True)).to_be_visible()
        phase[0] = "aired"
        page.reload()
        expect(page.get_by_role("button", name="Удалить из личных закладок", exact=True)).to_be_visible()
        page.get_by_role("button", name="+ Заказ", exact=True).click()
        expect(page.get_by_text("Прозвучало", exact=True)).to_be_visible()
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1")
        page.screenshot(path=str(artifacts / f"listener-{browser_type.name}-{width}.png"), full_page=True)
        page.keyboard.press("Escape")
        page.keyboard.press("1")
        page.locator("summary").filter(has_text="Мои закладки").click()
        page.get_by_role("button", name="Удалить", exact=True).first.click()
        page.wait_for_function("JSON.parse(localStorage.getItem('subwave-bookmarks-v1')).length === 1")
        isolated = browser.new_context()
        fresh = isolated.new_page()
        fresh.goto("http://127.0.0.1:7793")
        assert fresh.evaluate("localStorage.getItem('subwave-bookmarks-v1')") is None
        isolated.close()
        assert not errors, errors
        print(f"PASS {browser_type.name} {width}px: bookmarks/export/isolation, stale ID, 429/502, receipt reload", flush=True)
    finally:
        context.close()
        browser.close()


if __name__ == "__main__":
    artifacts = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd() / "listener-verification"
    artifacts.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        for engine in [pw.chromium, pw.webkit]:
            for width in [320, 393]:
                check(engine, width, artifacts)
