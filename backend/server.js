



// server-session.js - Use saved session to send messages
import bodyParser from 'body-parser';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path, { dirname } from 'path';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { fileURLToPath } from 'url';
import { chromium } from "playwright";

// Use puppeteer-extra (it will automatically use puppeteer-core since puppeteer is not installed)
const puppeteer = puppeteerExtra;

// Use enhanced stealth plugin
const stealthPlugin = StealthPlugin();
stealthPlugin.enabledEvasions.delete('chrome.runtime');
stealthPlugin.enabledEvasions.delete('iframe.contentWindow');
puppeteer.use(stealthPlugin);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Session / profile configuration
const SESSION_FILE = path.join(__dirname, 'cookies.json');
const DEFAULT_PROFILE_DIR = path.join(__dirname, 'chrome-profile');
let resolvedPersistentDir = null;

if (process.env.PERSISTENT_PROFILE_DIR && process.env.PERSISTENT_PROFILE_DIR.trim().length > 0) {
    resolvedPersistentDir = path.resolve(process.env.PERSISTENT_PROFILE_DIR);
} else if (process.env.ENABLE_PERSISTENT_PROFILE === '1') {
    // Backwards compat flag if a path wasn't provided
    resolvedPersistentDir = DEFAULT_PROFILE_DIR;
}

const USE_PERSISTENT_PROFILE = !!resolvedPersistentDir;

if (USE_PERSISTENT_PROFILE) {
    fs.mkdirSync(resolvedPersistentDir, { recursive: true });
    console.log(`[Persistent Profile] Using Chrome profile at: ${resolvedPersistentDir}`);
}



// Always use Playwright Chromium on Render
const getChromeExecutablePath = () => {
    try {
        const pwPath = chromium.executablePath();
        console.log("Playwright Chromium →", pwPath);
        return pwPath;
    } catch (err) {
        console.log("Failed to get Playwright Chromium path:", err.message);
        return null;
    }
};




const app = express();

// CORS support for Render hosting (allows frontend to be hosted separately if needed)
app.use((req, res, next) => {
    const origin = req.headers.origin || "*";

    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader(
        "Access-Control-Allow-Headers",
        "Origin, X-Requested-With, Content-Type, Accept, Authorization"
    );
    res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS"
    );

    if (req.method === "OPTIONS") {
        return res.status(200).end();
    }

    next();
});


app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve the frontend at root
app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Diagnostic endpoint to find Chrome path (useful for Render setup)
app.get('/diagnose-chrome', (_req, res) => {
    const results = {
        chromeExecutablePath: getChromeExecutablePath(),
        environmentVariables: {
            CHROME_EXECUTABLE_PATH: process.env.CHROME_EXECUTABLE_PATH || 'not set',
            CHROME_PATH: process.env.CHROME_PATH || 'not set',
            GOOGLE_CHROME_SHIM: process.env.GOOGLE_CHROME_SHIM || 'not set',
            PATH: process.env.PATH || 'not set'
        },
        commonPaths: [
            '/usr/bin/google-chrome',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/usr/bin/google-chrome-stable',
            '/snap/bin/chromium'
        ].map(p => ({
            path: p,
            exists: fs.existsSync(p)
        })),
        recommendation: 'Set CHROME_EXECUTABLE_PATH environment variable in Render dashboard to the path shown above'
    };
    
    res.json(results);
});

// Endpoint to download the session.json file
app.get('/download-session', (req, res) => {
    try {
        if (!fs.existsSync(SESSION_FILE)) {
            return res.status(404).json({
                success: false,
                error: 'Session file not found. Please export a session first using /export-session'
            });
        }
        
        res.download(SESSION_FILE, 'session.json', (err) => {
            if (err) {
                console.error('Error downloading session file:', err);
                if (!res.headersSent) {
                    res.status(500).json({
                        success: false,
                        error: 'Failed to download session file'
                    });
                }
            }
        });
    } catch (error) {
        console.error('Error in /download-session endpoint:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to download session file'
        });
    }
});

// Endpoint to save current session to a separate file (POST with optional fileName in body, or GET)
app.post('/save-session', async (req, res) => {
    try {
        const { fileName } = req.body; // Optional custom filename
        
        // Ensure browser is initialized
        let { page: mainPage } = await initializeBrowser();
        
        // Verify page is still ready
        try {
            const isClosed = mainPage.isClosed();
            if (isClosed) {
                return res.status(500).json({ 
                    success: false, 
                    error: 'Browser page is closed. Please restart the server.' 
                });
            }
        } catch (e) {
            return res.status(500).json({ 
                success: false, 
                error: 'Browser page is not available. Please restart the server.' 
            });
        }
        
        // Save the session
        const result = await saveSession(mainPage, fileName);
        
        if (result.success) {
            res.json({
                success: true,
                message: 'Session saved successfully',
                fileName: result.fileName,
                filePath: result.filePath,
                cookiesCount: result.cookiesCount,
                localStorageCount: result.localStorageCount
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.error || 'Failed to save session'
            });
        }
    } catch (error) {
        console.error('Error in /save-session endpoint:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to save session'
        });
    }
});

// Endpoint to export session to session.json (for use on another device)
app.post('/export-session', async (req, res) => {
    try {
        // Ensure browser is initialized
        let { page: mainPage } = await initializeBrowser();
        
        // Verify page is still ready
        try {
            const isClosed = mainPage.isClosed();
            if (isClosed) {
                return res.status(500).json({ 
                    success: false, 
                    error: 'Browser page is closed. Please restart the server.' 
                });
            }
        } catch (e) {
            return res.status(500).json({ 
                success: false, 
                error: 'Browser page is not available. Please restart the server.' 
            });
        }
        
        // Export the session to session.json
        const result = await exportSession(mainPage);
        
        if (result.success) {
            res.json({
                success: true,
                message: 'Session exported successfully to session.json. This file can be transferred to another device.',
                fileName: result.fileName,
                filePath: result.filePath,
                cookiesCount: result.cookiesCount,
                localStorageCount: result.localStorageCount,
                instructions: 'Copy session.json to another device and place it in the same directory as server-session.js. It will be automatically loaded on startup.'
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.error || 'Failed to export session'
            });
        }
    } catch (error) {
        console.error('Error in /export-session endpoint:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to export session'
        });
    }
});

// GET endpoint to export session (easier access)
app.get('/export-session', async (req, res) => {
    try {
        // Ensure browser is initialized
        let { page: mainPage } = await initializeBrowser();
        
        // Verify page is still ready
        try {
            const isClosed = mainPage.isClosed();
            if (isClosed) {
                return res.status(500).json({ 
                    success: false, 
                    error: 'Browser page is closed. Please restart the server.' 
                });
            }
        } catch (e) {
            return res.status(500).json({ 
                success: false, 
                error: 'Browser page is not available. Please restart the server.' 
            });
        }
        
        // Export the session to session.json
        const result = await exportSession(mainPage);
        
        if (result.success) {
            res.json({
                success: true,
                message: 'Session exported successfully to session.json. This file can be transferred to another device.',
                fileName: result.fileName,
                filePath: result.filePath,
                cookiesCount: result.cookiesCount,
                localStorageCount: result.localStorageCount,
                instructions: 'Copy session.json to another device and place it in the same directory as server-session.js. It will be automatically loaded on startup.'
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.error || 'Failed to export session'
            });
        }
    } catch (error) {
        console.error('Error in /export-session endpoint:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to export session'
        });
    }
});

// GET endpoint for easier access (optional fileName as query parameter)
app.get('/save-session', async (req, res) => {
    try {
        const { fileName } = req.query; // Optional custom filename from query string
        
        // Ensure browser is initialized
        let { page: mainPage } = await initializeBrowser();
        
        // Verify page is still ready
        try {
            const isClosed = mainPage.isClosed();
            if (isClosed) {
                return res.status(500).json({ 
                    success: false, 
                    error: 'Browser page is closed. Please restart the server.' 
                });
            }
        } catch (e) {
            return res.status(500).json({ 
                success: false, 
                error: 'Browser page is not available. Please restart the server.' 
            });
        }
        
        // Save the session
        const result = await saveSession(mainPage, fileName);
        
        if (result.success) {
            res.json({
                success: true,
                message: 'Session saved successfully',
                fileName: result.fileName,
                filePath: result.filePath,
                cookiesCount: result.cookiesCount,
                localStorageCount: result.localStorageCount
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.error || 'Failed to save session'
            });
        }
    } catch (error) {
        console.error('Error in /save-session endpoint:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to save session'
        });
    }
});

// Global browser instance (reused across requests)
let globalBrowser = null;
let globalContext = null;
let globalPage = null;
let isInitializing = false;
let initializationPromise = null;

// Helper functions
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 🔥 PART 1 — Extract ALL messages (text only)
const getAllMessages = async (page) => {
    try {
        const messages = await page.evaluate(() => {
            return [...document.querySelectorAll("ol div.prose.prose-sm")].map(el =>
                (el.innerText || "").trim()
            );
        });
        return messages;
    } catch (error) {
        console.log('Error getting all messages:', error.message);
        return [];
    }
};

// 🔥 PART 2 — Get latest AI response
// Latest AI response = last index that belongs to AI (odd indices: 1, 3, 5, ...)
const getLatestAI = (messages) => {
    // Scan from bottom upward
    for (let i = messages.length - 1; i >= 0; i--) {
        if (i % 2 === 1) {
            return messages[i];
        }
    }
    return null;
};

// 🔥 PART 3 — Get nth AI response
// Using the formula: aiIndex = (2 * n) - 1
const getNthAI = (messages, n) => {
    const index = (2 * n) - 1;
    if (index < 0 || index >= messages.length) return null;
    return messages[index];
};

// 🔥 PART 4 — Detect streaming state
const isStreaming = async (page) => {
    try {
        return await page.evaluate(() =>
            !!document.querySelector(".cursor-blink, [data-state='streaming']")
        );
    } catch (error) {
        console.log('Error detecting streaming state:', error.message);
        return false;
    }
};

// 🔥 PART 5 — Wait for the AI response to finish streaming
const waitForResponseStable = async (page, timeout = 60000) => {
    const start = Date.now();
    let last = "";
    let stableCount = 0;

    while (Date.now() - start < timeout) {
        const messages = await getAllMessages(page);
        const latestAI = getLatestAI(messages);
        const streaming = await isStreaming(page);

        if (latestAI && !streaming) {
            if (latestAI === last) {
                stableCount++;
                if (stableCount >= 2) return messages;
            } else {
                last = latestAI;
                stableCount = 1;
            }
        }

        await wait(500);
    }

    return await getAllMessages(page);
};

const tryQuerySelector = async (page, selector, options = {}) => {
    const { timeout = 30000, visible = true } = options;
    try {
        await page.waitForSelector(selector, { timeout, visible });
        const handle = await page.$(selector);
        if (!handle) throw new Error(`Selector not found: ${selector}`);
        return handle;
    } catch (err) {
        throw new Error(`Selector not found: ${selector} - ${err.message}`);
    }
};

const tryXPath = async (page, xpath, options = {}) => {
    const { timeout = 30000 } = options;
    try {
        await page.waitForXPath(xpath, { timeout });
        const handles = await page.$x(xpath);
        if (!handles || !handles.length) throw new Error(`XPath not found: ${xpath}`);
        return handles[0];
    } catch (err) {
        throw new Error(`XPath not found: ${xpath} - ${err.message}`);
    }
};

const waitAndClick = async (page, handleOrSelector, options = {}) => {
    const { retries = 3, delayMs = 500, timeout = 15000 } = options;
    let handle = null;
    
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            if (typeof handleOrSelector === 'string') {
                handle = await tryQuerySelector(page, handleOrSelector, { visible: true, timeout });
            } else {
                handle = handleOrSelector;
            }

            const box = await handle.boundingBox();
            if (!box) {
                await handle.scrollIntoViewIfNeeded?.();
                await wait(300);
            }
            
            await handle.click({ delay: 50 });
            await wait(500);
            return;
        } catch (err) {
            if (attempt < retries) {
                await wait(delayMs * (attempt + 1));
                continue;
            }
            throw err;
        }
    }
};

// Navigate with retries and proper load detection
const gotoWithRetries = async (page, url, maxRetries = 3) => {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            console.log(`Navigation attempt ${attempt + 1}/${maxRetries} to ${url}`);
            
            // Wait a bit before navigation to ensure page is ready
            await wait(1000);
            
            await page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: 120000
            });
            
            // Wait for page to be interactive
            await page.waitForFunction(
                () => document.readyState === 'complete',
                { timeout: 30000 }
            ).catch(() => {
                console.log('Page readyState check timed out, continuing...');
            });
            
            await wait(2000);
            
            // Check if page is actually loaded by looking for key elements
            const pageLoaded = await page.evaluate(() => {
                // Check if we have a body with content
                const hasBody = document.body && document.body.children.length > 0;
                // Check for common page elements
                const hasContent = document.querySelector('body') !== null;
                return hasBody && hasContent;
            });
            
            if (pageLoaded) {
                console.log('✓ Page navigation successful');
                return true;
            } else {
                throw new Error('Page loaded but no content detected');
            }
        } catch (error) {
            if (error.message.includes('Requesting main frame too early')) {
                console.log('Page not ready, waiting longer...');
                await wait(3000);
                continue;
            }
            
            if (attempt < maxRetries - 1) {
                console.log(`Navigation attempt ${attempt + 1} failed: ${error.message}, retrying...`);
                await wait(3000);
            } else {
                throw error;
            }
        }
    }
};

// Wait for page to be fully ready with key elements
const waitForPageReady = async (page, maxWaitTime = 60000) => {
    console.log('Waiting for page to be fully ready...');
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWaitTime) {
        try {
            const isReady = await page.evaluate(() => {
                // Check document ready state
                if (document.readyState !== 'complete') {
                    return { ready: false, reason: 'document not complete' };
                }
                
                // Check if we have body content
                if (!document.body || document.body.children.length === 0) {
                    return { ready: false, reason: 'no body content' };
                }
                
                // Check for key elements that indicate the page is loaded
                const hasTextarea = document.querySelector('textarea, [contenteditable="true"]') !== null;
                const hasModelDropdown = document.querySelector('button[role="combobox"]') !== null;
                const hasButtons = document.querySelector('button') !== null;
                const hasForm = document.querySelector('form') !== null;
                
                // At least one of these should be present
                const hasKeyElements = hasTextarea || hasModelDropdown || hasButtons || hasForm;
                
                if (!hasKeyElements) {
                    return { ready: false, reason: 'key elements not found' };
                }
                
                // Check if page is not still loading (no loading indicators)
                const pageText = (document.body.innerText || document.body.textContent || '').toLowerCase();
                const isLoading = pageText.includes('loading...') || 
                                 pageText.includes('please wait') ||
                                 pageText.includes('checking your browser');
                
                if (isLoading && !pageText.includes('lmarena')) {
                    return { ready: false, reason: 'still loading' };
                }
                
                return { ready: true };
            });
            
            if (isReady.ready) {
                console.log('✓ Page is fully ready');
                await wait(2000); // Extra wait to ensure everything is settled
                return true;
            } else {
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                if (elapsed % 5 === 0 && elapsed > 0) {
                    console.log(`  Waiting for page to be ready... (${elapsed}s) - ${isReady.reason}`);
                }
                await wait(2000);
            }
        } catch (error) {
            console.log(`Error checking page readiness: ${error.message}`);
            await wait(2000);
        }
    }
    
    console.log('⚠ Page readiness check timed out, proceeding anyway...');
    return false;
};

// Check for Security Verification
const checkSecurityVerification = async (page) => {
    try {
        const hasSecurityVerification = await page.evaluate(() => {
            const pageText = (document.body.innerText || document.body.textContent || '').toLowerCase();
            const pageHTML = document.body.innerHTML.toLowerCase();
            return pageText.includes('security verification') || 
                   pageText.includes('please complete this quick security check') ||
                   pageText.includes('checking your browser') ||
                   pageText.includes('just a moment') ||
                   pageText.includes('cloudflare') ||
                   pageHTML.includes('cf-browser-verification') ||
                   pageHTML.includes('cf-challenge') ||
                   document.querySelector('#challenge-form, .cf-browser-verification, [data-ray]') !== null;
        });
        
        if (hasSecurityVerification) {
            console.log('⚠ Cloudflare Security Verification detected - waiting for completion...');
            console.log('  (This may take up to 2 minutes. If using persistent profile, this should only happen once.)');
            const startTime = Date.now();
            const maxWait = 120000; // 2 minutes
            
            while (Date.now() - startTime < maxWait) {
                await wait(3000);
                
                const stillPresent = await page.evaluate(() => {
                    const pageText = (document.body.innerText || document.body.textContent || '').toLowerCase();
                    const pageHTML = document.body.innerHTML.toLowerCase();
                    return pageText.includes('security verification') || 
                           pageText.includes('please complete this quick security check') ||
                           pageText.includes('checking your browser') ||
                           pageText.includes('just a moment') ||
                           pageHTML.includes('cf-browser-verification') ||
                           pageHTML.includes('cf-challenge') ||
                           document.querySelector('#challenge-form, .cf-browser-verification, [data-ray]') !== null;
                });
                
                if (!stillPresent) {
                    await wait(3000);
                    const finalCheck = await page.evaluate(() => {
                        const pageText = (document.body.innerText || document.body.textContent || '').toLowerCase();
                        const pageHTML = document.body.innerHTML.toLowerCase();
                        // Check if we're now on the actual lmarena page
                        const hasLMArenaContent = pageText.includes('lmarena') || 
                                                  document.querySelector('textarea, button[role="combobox"]') !== null;
                        return !pageText.includes('security verification') && 
                               !pageText.includes('please complete this quick security check') &&
                               !pageText.includes('checking your browser') &&
                               !pageText.includes('just a moment') &&
                               !pageHTML.includes('cf-browser-verification') &&
                               !pageHTML.includes('cf-challenge') &&
                               document.querySelector('#challenge-form, .cf-browser-verification, [data-ray]') === null &&
                               hasLMArenaContent;
                    });
                    
                    if (finalCheck) {
                        console.log('✓ Cloudflare Security Verification completed');
                        // Wait a bit more for page to fully load
                        await wait(2000);
                        return true;
                    }
                }
                
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                if (elapsed % 15 === 0 && elapsed > 0) {
                    console.log(`  Still waiting for Cloudflare verification... (${elapsed}s / ${Math.floor(maxWait/1000)}s max)`);
                }
            }
            
            console.log('⚠ Cloudflare Security Verification timed out - page may still be verifying');
            console.log('  If this persists, cookies may be expired. Consider using persistent profile mode.');
        }
        
        return true;
    } catch (err) {
        console.log('Error checking security verification:', err.message);
        return true; // Continue anyway
    }
};

// Initialize browser and page on startup
const initializeBrowser = async () => {
    if (isInitializing) {
        // Wait for existing initialization
        return initializationPromise;
    }
    
    if (globalBrowser && globalPage) {
        // Already initialized, check if still valid
        try {
            const isClosed = globalPage.isClosed();
            if (!isClosed) {
                return { browser: globalBrowser, context: globalContext, page: globalPage };
            }
        } catch (e) {
            // Page is closed or invalid, reinitialize
            console.log('Browser/page invalid, reinitializing...');
        }
    }
    
    isInitializing = true;
    initializationPromise = (async () => {
        try {
            console.log('Initializing browser and loading page...');
            
            // Get Chrome executable path
            const executablePath = getChromeExecutablePath();
            
            // Base args for Chrome/Chromium
            const baseArgs = [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--window-size=1280,900',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--lang=en-US,en',
                '--disable-infobars',
                '--disable-notifications',
                '--disable-popup-blocking',
                '--disable-translate',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--disable-features=TranslateUI',
                '--disable-ipc-flooding-protection',
                '--enable-features=NetworkService,NetworkServiceInProcess',
                '--force-color-profile=srgb',
                '--metrics-recording-only',
                '--use-mock-keychain',
                '--hide-scrollbars',
                '--mute-audio',
                '--no-default-browser-check',
                '--no-pings',
                '--password-store=basic',
                '--use-gl=swiftshader',
                '--disable-extensions-except',
                '--disable-extensions',
                '--disable-plugins-discovery',
                '--disable-preconnect',
                '--disable-sync',
                '--disable-background-networking',
                '--disable-default-apps',
                '--disable-component-extensions-with-background-pages'
            ];
            
            const launchOptions = {
    headless: true, // REQUIRED ON RENDER
    executablePath: executablePath || undefined,
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-infobars',
        '--disable-notifications',
        '--window-size=1280,900',
        '--disable-web-security'
    ],
    ignoreHTTPSErrors: true,
    ignoreDefaultArgs: ['--enable-automation'],
    protocolTimeout: 180000,
};


            if (USE_PERSISTENT_PROFILE) {
                launchOptions.userDataDir = resolvedPersistentDir;
            }

            const browser = await puppeteer.launch(launchOptions);

            let context;
            let page;

            if (USE_PERSISTENT_PROFILE) {
                context = browser.defaultBrowserContext();
                try {
                    await context.overridePermissions('https://lmarena.ai', ['notifications']);
                } catch (permErr) {
                    console.log('Warning: Could not override permissions on default context:', permErr.message);
                }
                const existingPages = await browser.pages();
                page = existingPages.length ? existingPages[0] : await browser.newPage();
            } else {
                context = await browser.createIncognitoBrowserContext();
                await context.overridePermissions('https://lmarena.ai', ['notifications']);
                page = await context.newPage();
            }

            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36');
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Cache-Control': 'max-age=0'
            });
            await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
            page.setDefaultNavigationTimeout(120000);
            
            // Enhanced stealth
            await page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => undefined,
                });
                Object.defineProperty(navigator, 'plugins', {
                    get: () => [1, 2, 3, 4, 5],
                });
                Object.defineProperty(navigator, 'languages', {
                    get: () => ['en-US', 'en'],
                });
                window.chrome = { runtime: {} };
            });

            await wait(1000);

            // Load session
            console.log('Loading saved session...');
            await loadSession(page);

            // Navigate to llmarena with retries and proper load detection
            console.log('Navigating to lmarena.ai...');
            await gotoWithRetries(page, 'https://lmarena.ai/?mode=direct', 3);
            
            // Wait for page to be fully ready
            await waitForPageReady(page, 90000);
            
            // Additional wait to ensure everything is settled
            await wait(3000);

            // Check for security verification
            await checkSecurityVerification(page);
            
            // Verify page is still ready after security check
            await waitForPageReady(page, 30000);

            // Handle user agreement if needed
            try {
                const agreeButtons = await page.$x(
                    "//button[contains(., 'Agree') or contains(., 'I agree') or contains(., 'Accept')]"
                );
                if (agreeButtons.length > 0) {
                    await waitAndClick(page, agreeButtons[0]);
                    await wait(2000);
                }
            } catch (e) {
                // Ignore
            }
            
            // Automatically export current session to session.json (for use on another device)
            console.log('\n=== Exporting current session ===');
            const exportResult = await exportSession(page);
            if (exportResult.success) {
                console.log(`✓ Session exported to: ${exportResult.fileName}`);
                console.log(`  This file can be transferred to another device for automatic login.`);
            } else {
                console.log(`⚠ Could not export session: ${exportResult.error || 'Unknown error'}`);
            }
            console.log('==================================\n');
            
            // Store globally
            globalBrowser = browser;
            globalContext = context;
            globalPage = page;
            
            console.log('✓ Browser initialized and page loaded successfully');
            isInitializing = false;
            
            return { browser, context, page };
        } catch (error) {
            isInitializing = false;
            console.error('Error initializing browser:', error);
            throw error;
        }
    })();
    
    return initializationPromise;
};

// Load session (cookies and localStorage)
const loadSession = async (page) => {
    try {
        if (!fs.existsSync(SESSION_FILE)) {
            console.log('No saved session found');
            return false;
        }
        
        const fileData = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
        let cookies = [];
        let localStorage = {};
        let savedAt = null;
        
        // Handle both formats:
        // 1. Array of cookies directly: [{name: "...", value: "..."}, ...]
        // 2. Full session object: {cookies: [...], localStorage: {...}, savedAt: "...", url: "..."}
        if (Array.isArray(fileData)) {
            // Format 1: Direct array of cookies
            cookies = fileData;
            console.log(`Detected cookies array format (${cookies.length} cookies)`);
        } else if (fileData.cookies && Array.isArray(fileData.cookies)) {
            // Format 2: Full session object
            cookies = fileData.cookies;
            localStorage = fileData.localStorage || {};
            savedAt = fileData.savedAt;
            console.log(`Detected full session object format (${cookies.length} cookies)`);
        } else {
            console.log('Warning: Unknown session file format');
            return false;
        }
        
        let cookiesLoaded = false;
        
        // Set cookies - MUST navigate to the domain first for cookies to be set properly
        if (cookies.length > 0) {
            try {
                // Navigate to base domain first (required for setting cookies)
                console.log('Navigating to base domain to set cookies...');
                await page.goto('https://lmarena.ai', { 
                    waitUntil: 'domcontentloaded', 
                    timeout: 30000 
                });
                await wait(2000); // Wait for page to settle
                
                // Filter out cookies with partitionKey (CHIPS cookies) as they can't be set via setCookie
                const setableCookies = cookies.filter(cookie => !cookie.partitionKey);
                const skippedCount = cookies.length - setableCookies.length;
                
                if (setableCookies.length > 0) {
                    // Check for expired cookies and filter them out
                    const now = Math.floor(Date.now() / 1000);
                    const validCookies = [];
                    const expiredCookies = [];
                    
                    setableCookies.forEach(cookie => {
                        // Check if cookie has expires field and if it's expired
                        if (cookie.expires && cookie.expires < now) {
                            expiredCookies.push(cookie.name);
                        } else {
                            validCookies.push(cookie);
                        }
                    });
                    
                    if (expiredCookies.length > 0) {
                        console.log(`⚠ Warning: ${expiredCookies.length} cookies are expired: ${expiredCookies.join(', ')}`);
                        console.log(`  These cookies will not be loaded. You may need to complete Cloudflare verification.`);
                    }
                    
                    if (validCookies.length > 0) {
                        // Ensure cookies have proper domain format
                        const normalizedCookies = validCookies.map(cookie => {
                            const normalized = { ...cookie };
                            // Ensure domain starts with . for cross-subdomain cookies
                            if (normalized.domain && !normalized.domain.startsWith('.') && normalized.domain.includes('lmarena.ai')) {
                                normalized.domain = '.' + normalized.domain.replace(/^\.*/, '');
                            }
                            // Remove partitionKey if present (we already filtered, but just in case)
                            delete normalized.partitionKey;
                            return normalized;
                        });
                        
                        await page.setCookie(...normalizedCookies);
                        console.log(`✓ Loaded ${normalizedCookies.length} valid cookies from session`);
                        if (skippedCount > 0) {
                            console.log(`  (Skipped ${skippedCount} partitioned cookies - they will be set by the browser automatically)`);
                        }
                        cookiesLoaded = true;
                        
                        // Wait a bit for cookies to be processed
                        await wait(1000);
                    } else {
                        console.log(`⚠ All cookies are expired or partitioned. Cloudflare verification may be required.`);
                        cookiesLoaded = true; // Still consider it loaded to proceed
                    }
                } else if (skippedCount > 0) {
                    console.log(`⚠ All ${skippedCount} cookies are partitioned - they will be set by the browser automatically`);
                    cookiesLoaded = true; // Consider it loaded even if we can't set them manually
                }
            } catch (err) {
                console.log('Warning: Could not load cookies:', err.message);
                console.log('  Error details:', err);
            }
        }
        
        // Set localStorage (optional - cookies are usually enough)
        if (localStorage && Object.keys(localStorage).length > 0) {
            try {
                await page.goto('https://lmarena.ai', { waitUntil: 'domcontentloaded', timeout: 30000 });
                await wait(1000);
                
                await page.evaluate((localStorageData) => {
                    try {
                        for (const [key, value] of Object.entries(localStorageData)) {
                            window.localStorage.setItem(key, value);
                        }
                    } catch (e) {
                        // Ignore localStorage errors
                    }
                }, localStorage);
                console.log(`✓ Loaded ${Object.keys(localStorage).length} localStorage items`);
            } catch (err) {
                console.log('Warning: Could not load localStorage (cookies are enough):', err.message);
            }
        }
        
        if (cookiesLoaded) {
            if (savedAt) {
                console.log(`Session loaded (saved at: ${savedAt})`);
            } else {
                console.log('Session loaded from cookies file');
            }
            return true;
        } else {
            console.log('No cookies loaded from session');
            return false;
        }
    } catch (err) {
        console.log('Error loading session:', err.message);
        return false;
    }
};

// Extract current session from browser (cookies and localStorage)
const extractSession = async (page) => {
    try {
        if (!page || page.isClosed()) {
            throw new Error('Page is not available or closed');
        }

        // Get current cookies
        const cookies = await page.cookies();
        
        // Get localStorage
        const localStorage = await page.evaluate(() => {
            const items = {};
            try {
                for (let i = 0; i < window.localStorage.length; i++) {
                    const key = window.localStorage.key(i);
                    items[key] = window.localStorage.getItem(key);
                }
            } catch (e) {
                console.log('Warning: Could not access localStorage:', e.message);
            }
            return items;
        });
        
        return {
            cookies: cookies,
            localStorage: localStorage,
            savedAt: new Date().toISOString(),
            url: page.url()
        };
    } catch (err) {
        throw new Error(`Failed to extract session: ${err.message}`);
    }
};

// Save current session to a separate file (with timestamp) - for backups
const saveSession = async (page, customFileName = null) => {
    try {
        const sessionData = await extractSession(page);
        
        // Generate filename with timestamp if not provided
        let fileName;
        if (customFileName) {
            fileName = customFileName;
        } else {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
            fileName = `session-backup-${timestamp}.json`;
        }
        
        const filePath = path.join(__dirname, fileName);
        fs.writeFileSync(filePath, JSON.stringify(sessionData, null, 2));
        
        console.log(`✓ Session saved successfully to ${fileName}`);
        console.log(`  - Cookies: ${sessionData.cookies.length}`);
        console.log(`  - LocalStorage items: ${Object.keys(sessionData.localStorage).length}`);
        console.log(`  - Saved at: ${sessionData.savedAt}`);
        
        return { 
            success: true, 
            filePath: filePath,
            fileName: fileName,
            cookiesCount: sessionData.cookies.length,
            localStorageCount: Object.keys(sessionData.localStorage).length
        };
    } catch (err) {
        console.error('Error saving session:', err.message);
        return { success: false, error: err.message };
    }
};

// Export session to main session.json file (for use on another device)
const exportSession = async (page) => {
    try {
        console.log('\n=== Extracting current session for export ===');
        
        const sessionData = await extractSession(page);
        
        // Save to main session.json file (this is the file that will be loaded on another device)
        fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionData, null, 2));
        
        console.log(`✓ Session exported successfully to ${path.basename(SESSION_FILE)}`);
        console.log(`  - Cookies: ${sessionData.cookies.length}`);
        console.log(`  - LocalStorage items: ${Object.keys(sessionData.localStorage).length}`);
        console.log(`  - Saved at: ${sessionData.savedAt}`);
        console.log(`\n📦 This session file can now be transferred to another device.`);
        console.log(`   Place it in the same directory as server-session.js and it will be automatically loaded.\n`);
        
        return { 
            success: true, 
            filePath: SESSION_FILE,
            fileName: path.basename(SESSION_FILE),
            cookiesCount: sessionData.cookies.length,
            localStorageCount: Object.keys(sessionData.localStorage).length,
            sessionData: sessionData // Return the data for API responses
        };
    } catch (err) {
        console.error('Error exporting session:', err.message);
        return { success: false, error: err.message };
    }
};

// Main chat endpoint
app.post('/chat', async (req, res) => {
    const { model, message, image } = req.body;

    try {
        // Ensure browser is initialized (will reuse if already initialized)
        let { browser, context, page: mainPage } = await initializeBrowser();
        
        // Verify page is still ready (might need to reload if page was closed)
        try {
            const isClosed = mainPage.isClosed();
            if (isClosed) {
                console.log('Page was closed, reinitializing...');
                globalBrowser = null;
                globalContext = null;
                globalPage = null;
                const reinit = await initializeBrowser();
                mainPage = reinit.page;
                browser = reinit.browser;
                context = reinit.context;
            }
        } catch (e) {
            console.log('Page check failed, reinitializing...');
            globalBrowser = null;
            globalContext = null;
            globalPage = null;
            const reinit = await initializeBrowser();
            mainPage = reinit.page;
            browser = reinit.browser;
            context = reinit.context;
        }
        
        // Quick check to ensure page is still on the right URL and ready
        const currentUrl = mainPage.url();
        if (!currentUrl.includes('lmarena.ai')) {
            console.log('Page not on lmarena.ai, navigating...');
            await gotoWithRetries(mainPage, 'https://lmarena.ai/?mode=direct', 3);
            await waitForPageReady(mainPage, 30000);
            await checkSecurityVerification(mainPage);
        } else {
            // Just verify page is still ready
            await checkSecurityVerification(mainPage);
            await waitForPageReady(mainPage, 10000);
        }

        // Step 1: Handle model selection (skip if gemini-2.5-pro is default)
        await checkSecurityVerification(mainPage);
        const defaultModel = 'gemini-2.5-pro';
        if (model && model !== defaultModel) {
            console.log('Opening model dropdown (model is not default)...');
            
            try {
                // Use the new method: get all comboboxes and click the second one (index 1)
                const dropdownOpened = await mainPage.evaluate(() => {
                    const comboboxes = document.querySelectorAll('button[role="combobox"]');
                    if (comboboxes.length > 1) {
                        const btn = comboboxes[1]; // Click the second combobox
                        btn.click();
                        return true;
                    } else if (comboboxes.length === 1) {
                        comboboxes[0].click();
                        return true;
                    }
                    return false;
                });
                
                if (dropdownOpened) {
                    await wait(2000); // Wait for dropdown to open
                    console.log('Selecting model:', model);
                    
                    try {
                        // Use the new method: find option by data-value and dispatch mouse events
                        const modelSelected = await mainPage.evaluate((modelName) => {
                            const el = document.querySelector(`div[role="option"][data-value="${modelName}"]`);
                            if (el) {
                                ["mousedown", "mouseup", "click"].forEach(evt => {
                                    el.dispatchEvent(new MouseEvent(evt, { bubbles: true }));
                                });
                                return true;
                            }
                            return false;
                        }, model);
                        
                        if (modelSelected) {
                            await wait(2000);
                            console.log('Model selected successfully');
                        } else {
                            console.log('Model option not found, trying alternative method...');
                            // Fallback: try to find by text content
                            try {
                                const modelOptionXPath = `//*[contains(@role, 'option') or contains(@class, 'option')]//*[normalize-space(text())='${model}']`;
                                const modelOption = await tryXPath(mainPage, modelOptionXPath, { timeout: 5000 });
                                await waitAndClick(mainPage, modelOption);
                                await wait(2000);
                                console.log('Model selected using fallback method');
                            } catch (e) {
                                console.log('Model selection failed, using default:', e.message);
                                try {
                                    await mainPage.keyboard.press('Escape');
                                    await wait(1000);
                                } catch (e2) {}
                            }
                        }
                    } catch (e) {
                        console.log('Model selection failed, using default:', e.message);
                        try {
                            await mainPage.keyboard.press('Escape');
                            await wait(1000);
                        } catch (e2) {}
                    }
                } else {
                    console.log('Model dropdown not found, using default');
                }
            } catch (e) {
                console.log('Model dropdown failed, using default:', e.message);
            }
        } else {
            console.log('Skipping model selection (using default gemini-2.5-pro)');
        }

        // Step 2: Enter message
        await checkSecurityVerification(mainPage);
        console.log('Entering message...');
        const inputSelectors = [
            'textarea[name="message"]',
            'textarea',
            '[contenteditable="true"]',
            'form textarea',
            'div[contenteditable="true"]'
        ];

        let inputElement = null;
        for (const selector of inputSelectors) {
            try {
                inputElement = await tryQuerySelector(mainPage, selector, { timeout: 15000 });
                if (inputElement) break;
            } catch (e) {
                continue;
            }
        }

        if (!inputElement) {
            throw new Error('Could not find message input');
        }

        await inputElement.click();
        await wait(500);
        
        // Clear input
        try {
            await mainPage.keyboard.down('Control');
            await mainPage.keyboard.press('A');
            await mainPage.keyboard.up('Control');
            await wait(200);
            await mainPage.keyboard.press('Backspace');
            await wait(300);
        } catch (e) {
            try {
                await Promise.race([
                    inputElement.evaluate(el => {
                        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
                            el.value = '';
                        } else {
                            el.textContent = '';
                        }
                    }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
                ]);
            } catch (e2) {
                console.log('Could not clear input, continuing anyway');
            }
        }

        // Type message character by character to simulate real typing
        console.log('Typing message (simulating human typing)...');
        await inputElement.click();
        await wait(300);
        
        // Clear any existing content first
        try {
            await mainPage.keyboard.down('Control');
            await mainPage.keyboard.press('A');
            await mainPage.keyboard.up('Control');
            await wait(200);
            await mainPage.keyboard.press('Backspace');
            await wait(200);
        } catch (e) {
            console.log('Could not clear input with keyboard, continuing...');
        }
        
        // Type the message character by character with random delays to simulate human typing
        const typingDelay = () => Math.random() * 50 + 20; // 20-70ms delay between characters
        
        for (let i = 0; i < message.length; i++) {
            const char = message[i];
            
            // Handle special characters
            if (char === '\n') {
                await mainPage.keyboard.press('Enter');
            } else {
                await mainPage.keyboard.type(char, { delay: typingDelay() });
            }
            
            // Occasionally add a slightly longer pause (like a human thinking)
            if (i > 0 && i % 20 === 0) {
                await wait(100 + Math.random() * 100);
            }
        }
        
        // Final wait to ensure all input events are processed
        await wait(500);
        
        // Trigger input events to ensure the UI recognizes the input
        await mainPage.evaluate(() => {
            const activeEl = document.activeElement;
            if (activeEl) {
                if (activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'INPUT') {
                    activeEl.dispatchEvent(new Event('input', { bubbles: true }));
                    activeEl.dispatchEvent(new Event('change', { bubbles: true }));
                } else if (activeEl.isContentEditable) {
                    activeEl.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }
        });
        
        await wait(1000);
        console.log('Message typed successfully');

        // Step 3: Handle image upload if provided
        if (image) {
            await checkSecurityVerification(mainPage);
            console.log('Handling image upload...');
            try {
                const fileInputSelectors = [
                    'input[type="file"]',
                    'input[accept*="image"]',
                    'input[accept*="image/*"]'
                ];

                for (const selector of fileInputSelectors) {
                    try {
                        const fileInput = await tryQuerySelector(mainPage, selector, { timeout: 5000 });
                        if (fileInput) {
                            let imageBuffer;
                            if (image.startsWith('data:')) {
                                const base64Data = image.split(',')[1];
                                imageBuffer = Buffer.from(base64Data, 'base64');
                            } else {
                                imageBuffer = Buffer.from(image, 'base64');
                            }

                            const tempDir = os.tmpdir();
                            const tempFile = path.join(tempDir, `upload_${crypto.randomBytes(8).toString('hex')}.png`);
                            fs.writeFileSync(tempFile, imageBuffer);

                            await fileInput.uploadFile(tempFile);
                            await wait(2000);

                            try {
                                fs.unlinkSync(tempFile);
                            } catch (e) {}

                            break;
                        }
                    } catch (e) {
                        continue;
                    }
                }
            } catch (e) {
                console.log('Image upload failed:', e.message);
            }
        }

        // Step 4: Click send button with multiple methods
        await checkSecurityVerification(mainPage);
        console.log('Sending message...');
        
        // Store the message we're sending to verify it was sent
        const messageToSend = message;
        
        // Get all possible send button selectors
        const sendButtonSelectors = [
            'button[type="submit"]',
            'button[aria-label*="send" i]',
            'button[title*="send" i]',
            'button[data-testid*="send" i]',
            'form button[type="submit"]',
            'button:has(svg)',
            'button[class*="send" i]',
            'button[class*="submit" i]'
        ];

        let sendButton = null;
        
        // First, find the send button
        for (const selector of sendButtonSelectors) {
            try {
                const btn = await tryQuerySelector(mainPage, selector, { timeout: 5000, visible: true });
                if (btn) {
                    // Verify it's actually a send button (not disabled, visible, etc.)
                    const isValid = await btn.evaluate(el => {
                        const style = window.getComputedStyle(el);
                        const rect = el.getBoundingClientRect();
                        return style.display !== 'none' && 
                               style.visibility !== 'hidden' && 
                               !el.disabled &&
                               rect.width > 0 && 
                               rect.height > 0;
                    });
                    
                    if (isValid) {
                        sendButton = btn;
                        console.log(`Found send button using selector: ${selector}`);
                        break;
                    }
                }
            } catch (e) {
                continue;
            }
        }
        
        // If not found by selectors, try to find by text content or position
        if (!sendButton) {
            try {
                console.log('Trying to find send button by text content...');
                const allButtons = await mainPage.$$('button');
                for (const btn of allButtons) {
                    const text = await btn.evaluate(el => el.textContent?.toLowerCase() || '');
                    const ariaLabel = await btn.evaluate(el => el.getAttribute('aria-label')?.toLowerCase() || '');
                    const title = await btn.evaluate(el => el.getAttribute('title')?.toLowerCase() || '');
                    
                    if (text.includes('send') || ariaLabel.includes('send') || title.includes('send')) {
                        const isVisible = await btn.evaluate(el => {
                            const style = window.getComputedStyle(el);
                            const rect = el.getBoundingClientRect();
                            return style.display !== 'none' && 
                                   style.visibility !== 'hidden' && 
                                   !el.disabled &&
                                   rect.width > 0 && 
                                   rect.height > 0;
                        });
                        
                        if (isVisible) {
                            sendButton = btn;
                            console.log('Found send button by text content');
                            break;
                        }
                    }
                }
            } catch (e) {
                console.log('Could not search all buttons:', e.message);
            }
        }
        
        let messageSent = false;
        
        // Try multiple click methods
        if (sendButton) {
            try {
                // Method 1: Scroll into view and click
                await sendButton.scrollIntoViewIfNeeded?.();
                await wait(500);
                await sendButton.click({ delay: 100 });
                console.log('Clicked send button using method 1 (scroll + click)');
                await wait(2000);
                
                // Verify message was sent (input should be cleared or message should appear in chat)
                const wasSent = await mainPage.evaluate((sentMessage) => {
                    // Check if input is cleared
                    const textarea = document.querySelector('textarea, [contenteditable="true"]');
                    if (textarea) {
                        const value = textarea.value || textarea.textContent || '';
                        if (value.trim() === '' || value.trim().length < sentMessage.length) {
                            return true; // Input was cleared, message likely sent
                        }
                    }
                    return false;
                }, messageToSend);
                
                if (wasSent) {
                    messageSent = true;
                    console.log('✓ Message sent successfully (input cleared)');
                } else {
                    // Method 2: JavaScript click
                    console.log('Input not cleared, trying JavaScript click...');
                    await sendButton.evaluate(el => {
                        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        el.click();
                    });
                    await wait(2000);
                    
                    const wasSent2 = await mainPage.evaluate((sentMessage) => {
                        const textarea = document.querySelector('textarea, [contenteditable="true"]');
                        if (textarea) {
                            const value = textarea.value || textarea.textContent || '';
                            if (value.trim() === '' || value.trim().length < sentMessage.length) {
                                return true;
                            }
                        }
                        return false;
                    }, messageToSend);
                    
                    if (wasSent2) {
                        messageSent = true;
                        console.log('✓ Message sent successfully (method 2)');
                    } else {
                        // Method 3: Dispatch click event
                        console.log('Trying dispatchEvent click...');
                        await sendButton.evaluate(el => {
                            const event = new MouseEvent('click', {
                                view: window,
                                bubbles: true,
                                cancelable: true
                            });
                            el.dispatchEvent(event);
                        });
                        await wait(2000);
                        
                        const wasSent3 = await mainPage.evaluate((sentMessage) => {
                            const textarea = document.querySelector('textarea, [contenteditable="true"]');
                            if (textarea) {
                                const value = textarea.value || textarea.textContent || '';
                                if (value.trim() === '' || value.trim().length < sentMessage.length) {
                                    return true;
                                }
                            }
                            return false;
                        }, messageToSend);
                        
                        if (wasSent3) {
                            messageSent = true;
                            console.log('✓ Message sent successfully (method 3)');
                        }
                    }
                }
            } catch (e) {
                console.log('Error clicking send button:', e.message);
            }
        }
        
        // Fallback: Try Enter key
        if (!messageSent) {
            console.log('Send button click failed, trying Enter key...');
            await mainPage.keyboard.press('Enter');
            await wait(2000);
            
            // Verify
            const wasSent = await mainPage.evaluate((sentMessage) => {
                const textarea = document.querySelector('textarea, [contenteditable="true"]');
                if (textarea) {
                    const value = textarea.value || textarea.textContent || '';
                    if (value.trim() === '' || value.trim().length < sentMessage.length) {
                        return true;
                    }
                }
                return false;
            }, messageToSend);
            
            if (wasSent) {
                messageSent = true;
                console.log('✓ Message sent using Enter key');
            } else {
                console.log('⚠ Warning: Could not verify message was sent');
            }
        }
        
        if (!messageSent) {
            throw new Error('Failed to send message - send button not clicked');
        }
        
        await wait(2000);

        // Step 5: Wait for AI response (stable) - using new message retrieval system
        await checkSecurityVerification(mainPage);
        console.log('Waiting for AI response...');
        
        // Wait for response to stabilize (5 minutes timeout)
        const messages = await waitForResponseStable(mainPage, 300000);
        const latest = getLatestAI(messages);
        
        // Calculate which AI response this is (for additional data)
        // Total messages after AI responds, user messages = Math.ceil((messages.length + 1) / 2)
        const userMessageCount = Math.ceil((messages.length + 1) / 2);
        const nth = getNthAI(messages, userMessageCount);
        
        if (!latest || latest.length < 5) {
            throw new Error('Timed out waiting for response or response too short');
        }
        
        console.log('Response received, length:', latest.length);
        console.log(`Total messages: ${messages.length}, Latest AI response captured`);
        
        // Return response in the format expected by frontend (backward compatible)
        res.json({ 
            response: latest,
            // Additional data for debugging/advanced use
            latest_response: latest,
            nth_response: nth,
            total_messages: messages.length
        });

    } catch (error) {
        console.error('Error in chat endpoint:', error);
        const friendly = error.message || 'An error occurred while processing your request';
        res.status(502).json({ error: friendly });
    }
    // DO NOT close browser/session - keep it open for reuse
    // Browser and page are kept alive for subsequent requests
});

// Initialize browser on server startup
const startServer = async () => {
    try {
        // Initialize browser and load page before starting server
        console.log('Initializing browser on startup...');
        await initializeBrowser();
        console.log('✓ Browser ready, starting server...');
    } catch (error) {
        console.error('Error initializing browser on startup:', error);
        console.log('Server will start anyway, browser will initialize on first request...');
    }
    
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT} (Session mode)`);
        console.log('Browser is ready and page is loaded');
    });
};

// Start the server
startServer();
