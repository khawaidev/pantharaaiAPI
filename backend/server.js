import express from "express";
import bodyParser from "body-parser";
import fs from "fs";
import path, { dirname } from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Persistent browser profile
const PROFILE = path.join(__dirname, "chrome-profile");
fs.mkdirSync(PROFILE, { recursive: true });

let globalBrowser = null;
let globalPage = null;
let isInitializing = false;

const wait = (ms) => new Promise(r => setTimeout(r, ms));

/* ============================================================
   INITIALIZE BROWSER
============================================================ */
async function initializeBrowser() {
    if (isInitializing) return;

    if (globalBrowser && globalPage && !globalPage.isClosed()) {
        return { browser: globalBrowser, page: globalPage };
    }

    isInitializing = true;

    const browser = await chromium.launchPersistentContext(PROFILE, {
        headless: true,
        viewport: { width: 1280, height: 900 }
    });

    const page = browser.pages()[0] || await browser.newPage();

    await page.goto("https://lmarena.ai/?mode=direct", {
        waitUntil: "domcontentloaded",
        timeout: 120000
    });

    await waitForUI(page);

    globalBrowser = browser;
    globalPage = page;
    isInitializing = false;

    return { browser, page };
}

/* ============================================================
   WAIT FOR UI TO LOAD
============================================================ */
async function waitForUI(page) {
    for (let i = 0; i < 40; i++) {
        const ready = await page.evaluate(() => {
            return document.querySelector("textarea, button") !== null;
        });
        if (ready) return;
        await wait(1000);
    }
}

/* ============================================================
   MODEL SELECTION (NEW FEATURE)
============================================================ */
async function selectModel(page, model) {
    const DEFAULT = "gemini-2.5-pro";

    if (!model || model === DEFAULT) {
        console.log("Using default model:", DEFAULT);
        return;
    }

    console.log("Selecting model:", model);

    // STEP 1 — Click dropdown
    try {
        await page.waitForSelector('button[role="combobox"]', { timeout: 10000 });
        const buttons = await page.$$('button[role="combobox"]');

        // LM Arena uses the second combobox for model selection
        const dropdown = buttons[1] || buttons[0];

        await dropdown.click();
        await wait(1000);
    } catch (err) {
        console.log("Model dropdown not found:", err.message);
        return;
    }

    // STEP 2 — Click model option
    try {
        const selector = `div[role="option"][data-value="${model}"]`;

        await page.waitForSelector(selector, { timeout: 8000 });
        const option = await page.$(selector);

        await option.click();
        await wait(1500);

        console.log("✓ Model selected:", model);
    } catch (err) {
        console.log("❌ Model not found in dropdown:", model);
    }
}

/* ============================================================
   SEND MESSAGE
============================================================ */
async function sendMessage(page, message) {
    const selector = "textarea, [contenteditable='true']";

    await page.waitForSelector(selector);
    const box = await page.$(selector);

    await box.click();
    await box.fill("");
    await box.type(message, { delay: 20 });

    await page.keyboard.press("Enter");
    await wait(1000);
}

/* ============================================================
   GET LATEST AI RESPONSE
============================================================ */
async function getLatestAI(page) {
    return await page.evaluate(() => {
        const nodes = [...document.querySelectorAll("ol div.prose.prose-sm")];
        if (nodes.length === 0) return null;
        return nodes[nodes.length - 1].innerText;
    });
}

/* ============================================================
   WAIT FOR AI RESPONSE
============================================================ */
async function waitForResponse(page) {
    let last = "";
    for (let i = 0; i < 120; i++) {
        const text = await getLatestAI(page);
        if (text && text === last && text.length > 10) return text;
        last = text;
        await wait(1000);
    }
    return last;
}

/* ============================================================
   EXPRESS SERVER
============================================================ */
const app = express();
app.use(bodyParser.json());

app.post("/chat", async (req, res) => {
    try {
        const { message, model } = req.body;

        const { page } = await initializeBrowser();

        // NEW — select model
        await selectModel(page, model);

        await sendMessage(page, message);

        const response = await waitForResponse(page);

        res.json({ response });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ============================================================
   START SERVER
============================================================ */
app.listen(3000, () => console.log("Server running on port 3000"));
