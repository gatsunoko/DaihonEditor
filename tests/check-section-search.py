"""Browser regression checks for section search; uses isolated browser storage."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
KEY = "script-editor-project-v1"
seed = {
    "projectId": "section-search-test", "title": "検索テスト",
    "activeSectionId": "a",
    "sections": [
        {"id": sid, "title": title, "notes": [], "lines": [
            {"id": sid + "1", "speaker": "", "body": sid + " body", "type": "dialogue"}
        ]}
        for sid, title in [
            ("a", "Alpha 第一章"), ("b", "beta 第二章"), ("c", "ALPHABET 最終章"),
            ("d", "D-1 シーン"), ("e", "Ｄ-2 シーン"), ("f", "d-3 シーン"),
        ]
    ], "speakers": {}, "settings": {},
}

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1600, "height": 1000})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto((ROOT / "index.html").as_uri())
    page.evaluate("([key, value]) => localStorage.setItem(key, value)", [KEY, json.dumps(seed)])
    page.reload()
    search = page.locator("#sectionSearch")
    titles = page.locator("#sectionTabs .tab-title")
    all_titles = ["全て表示"] + [section["title"] for section in seed["sections"]]
    expect(titles).to_have_text(all_titles)
    stored = page.evaluate("key => localStorage.getItem(key)", KEY)
    search.fill("aLpHa")
    expect(titles).to_have_text(["全て表示", "Alpha 第一章", "ALPHABET 最終章"])
    search.fill("第二")
    expect(titles).to_have_text(["全て表示", "beta 第二章"])
    expect(page.locator("#scriptRows .script-row")).to_have_count(0)
    expect(page.locator("#scriptRows")).to_contain_text("選択中のセクションは検索条件に一致しません")
    assert page.evaluate("key => localStorage.getItem(key)", KEY) == stored
    page.get_by_role("tab", name="beta 第二章").click()
    expect(page.locator('.script-row[data-line-id="b1"]')).to_be_visible()
    expect(page.get_by_role("tab", name="beta 第二章")).to_have_attribute("aria-selected", "true")
    search.fill("no match")
    expect(titles).to_have_text(["全て表示"])
    expect(page.locator("#scriptRows .script-row")).to_have_count(0)
    expect(page.locator("#scriptRows")).to_contain_text("検索条件に一致するセクションはありません")
    search.fill("")
    expect(titles).to_have_text(all_titles)
    expect(page.get_by_role("tab", name="beta 第二章")).to_have_attribute("aria-selected", "true")
    search.fill("alpha")
    page.get_by_role("tab", name="全て表示", exact=True).click()
    for sid in ["a", "c"]:
        expect(page.locator(f'.script-row[data-line-id="{sid}1"]')).to_be_visible()
    expect(page.locator('.script-row[data-line-id="b1"]')).to_have_count(0)
    expect(page.locator("#scriptRows .all-section-title")).to_have_text(["Alpha 第一章", "ALPHABET 最終章"])
    # Reproduce the screenshot: all-sections view, query D, unrelated sections hidden.
    d_titles = ["D-1 シーン", "Ｄ-2 シーン", "d-3 シーン"]
    for query in ["D", "d", "Ｄ", "ｄ", " D "]:
        search.fill(query)
        expect(titles).to_have_text(["全て表示"] + d_titles)
        expect(page.locator("#scriptRows .all-section-title")).to_have_text(d_titles)
        expect(page.locator("#scriptRows .script-row")).to_have_count(3)
        expect(page.locator("#sectionBodyChars")).to_have_text("18")
        for sid in ["a", "b", "c"]:
            expect(page.locator(f'.script-row[data-line-id="{sid}1"]')).to_have_count(0)
    search.fill("missing")
    expect(titles).to_have_text(["全て表示"])
    expect(page.locator("#scriptRows .script-row")).to_have_count(0)
    expect(page.locator("#sectionBodyChars")).to_have_text("0")
    search.fill("D")
    page.get_by_role("tab", name="Ｄ-2 シーン", exact=True).click()
    expect(page.locator('.script-row[data-line-id="e1"]')).to_be_visible()
    expect(page.locator("#scriptRows .script-row")).to_have_count(1)
    search.fill("alpha")
    expect(page.locator("#scriptRows .script-row")).to_have_count(0)
    search.fill("")
    expect(page.get_by_role("tab", name="Ｄ-2 シーン", exact=True)).to_have_attribute("aria-selected", "true")
    expect(page.locator('.script-row[data-line-id="e1"]')).to_be_visible()
    page.get_by_role("tab", name="全て表示", exact=True).click()
    expect(page.locator("#scriptRows .script-row")).to_have_count(6)
    expect(titles).to_have_text(all_titles)
    for width in [1920, 1600, 1200, 900, 640, 375]:
        page.set_viewport_size({"width": width, "height": 1000})
        title_box = page.locator("#projectTitle").bounding_box()
        search_box = search.bounding_box()
        assert search_box["x"] >= title_box["x"] + title_box["width"]
        assert abs(search_box["y"] - title_box["y"]) < 3
        assert search_box["x"] + search_box["width"] <= width, (width, title_box, search_box)
        assert title_box["width"] > 100
    assert not errors, errors
    browser.close()
    print("PASS: filtering, case, Japanese, empty/no matches, selection, switching, all view, storage, layout (375-1920px)")
