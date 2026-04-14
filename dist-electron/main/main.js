var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/main/main.ts
var import_electron5 = require("electron");
var import_path4 = __toESM(require("path"), 1);
var import_url = require("url");
var import_fs4 = __toESM(require("fs"), 1);

// src/main/services/BrowserManager.ts
var import_electron2 = require("electron");
var import_path2 = __toESM(require("path"), 1);
var import_fs2 = __toESM(require("fs"), 1);
var import_playwright_extra = require("playwright-extra");
var import_puppeteer_extra_plugin_stealth = __toESM(require("puppeteer-extra-plugin-stealth"), 1);

// src/main/services/ChromiumVersionHelper.ts
var import_fs = __toESM(require("fs"), 1);
var import_path = __toESM(require("path"), 1);
var import_electron = require("electron");
var ChromiumVersionHelper = class {
  static cachedVersion = null;
  static cachedRevision = null;
  static cachedUserAgent = null;
  /**
   * Gets Chromium version using a production-safe fallback chain:
   * 1. browsers.json via require() (handles asar transparency)
   * 2. Scan Playwright cache directory (external to app bundle)
   * 3. Hardcoded fallback (safety net)
   */
  static getChromiumVersion() {
    if (this.cachedVersion) return this.cachedVersion;
    this.cachedVersion = this.tryReadBrowsersJson();
    if (this.cachedVersion) return this.cachedVersion;
    this.cachedVersion = this.tryDetectFromCache();
    if (this.cachedVersion) return this.cachedVersion;
    console.warn("\u26A0\uFE0F ChromiumVersionHelper: Using hardcoded fallback version");
    this.cachedVersion = "143.0.0.0";
    return this.cachedVersion;
  }
  /**
   * Try reading version from playwright-core's browsers.json
   * Uses require() which handles asar transparency in production
   */
  static tryReadBrowsersJson() {
    try {
      const browsersJson = require("playwright-core/browsers.json");
      const chromiumEntry = browsersJson.browsers?.find(
        (b) => b.name === "chromium"
      );
      if (chromiumEntry?.browserVersion) {
        console.log(`\u{1F50D} ChromiumVersionHelper: Detected v${chromiumEntry.browserVersion} from browsers.json`);
        return chromiumEntry.browserVersion;
      }
    } catch (error) {
      console.log("\u{1F50D} ChromiumVersionHelper: browsers.json not accessible, trying cache scan...");
    }
    return null;
  }
  /**
   * Scan the Playwright cache directory to detect installed Chromium revision
   * This is production-safe because the cache is on the user's filesystem
   */
  static tryDetectFromCache() {
    try {
      const userHome = import_electron.app.getPath("home");
      const cacheDir = this.getPlaywrightCacheDir(userHome);
      if (!import_fs.default.existsSync(cacheDir)) return null;
      const revisions = import_fs.default.readdirSync(cacheDir).filter((d) => d.startsWith("chromium-") && !d.includes("headless")).map((d) => parseInt(d.replace("chromium-", ""), 10)).filter((n) => !isNaN(n)).sort((a, b) => b - a);
      if (revisions.length > 0) {
        const latestRevision = revisions[0];
        const version = this.revisionToVersion(latestRevision);
        console.log(`\u{1F50D} ChromiumVersionHelper: Detected revision ${latestRevision} \u2192 Chrome ${version}`);
        return version;
      }
    } catch (error) {
      console.warn("\u26A0\uFE0F ChromiumVersionHelper: Cache scan failed:", error);
    }
    return null;
  }
  /**
   * Maps Playwright revision numbers to approximate Chrome versions
   * Based on Playwright release history
   */
  static revisionToVersion(revision) {
    const versionMap = [
      [1255, "145.0.0.0"],
      [1220, "143.0.0.0"],
      [1200, "131.0.0.0"],
      [1140, "128.0.0.0"],
      [1100, "125.0.0.0"]
    ];
    for (const [knownRevision, version] of versionMap) {
      if (revision >= knownRevision) {
        return version;
      }
    }
    return "125.0.0.0";
  }
  /**
   * Gets the Playwright cache directory for the current platform
   */
  static getPlaywrightCacheDir(userHome) {
    if (process.platform === "darwin") {
      return import_path.default.join(userHome, "Library/Caches/ms-playwright");
    } else if (process.platform === "win32") {
      return import_path.default.join(userHome, "AppData/Local/ms-playwright");
    } else {
      return import_path.default.join(userHome, ".cache/ms-playwright");
    }
  }
  /**
   * Gets the latest installed Chromium revision number
   * Used for constructing the executable path
   */
  static getLatestRevision() {
    if (this.cachedRevision) return this.cachedRevision;
    try {
      const userHome = import_electron.app.getPath("home");
      const cacheDir = this.getPlaywrightCacheDir(userHome);
      if (!import_fs.default.existsSync(cacheDir)) {
        this.cachedRevision = "1200";
        return this.cachedRevision;
      }
      const revisions = import_fs.default.readdirSync(cacheDir).filter((d) => d.startsWith("chromium-") && !d.includes("headless")).map((d) => d.replace("chromium-", "")).filter((r) => !isNaN(parseInt(r, 10))).sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
      this.cachedRevision = revisions[0] || "1200";
      console.log(`\u{1F50D} ChromiumVersionHelper: Latest revision is ${this.cachedRevision}`);
    } catch (error) {
      console.warn("\u26A0\uFE0F ChromiumVersionHelper: Failed to detect revision:", error);
      this.cachedRevision = "1200";
    }
    return this.cachedRevision;
  }
  /**
   * Generates a platform-appropriate User-Agent string
   * Automatically uses the detected Chromium version
   */
  static generateUserAgent() {
    if (this.cachedUserAgent) return this.cachedUserAgent;
    const version = this.getChromiumVersion();
    const majorVersion = version.split(".")[0];
    if (process.platform === "darwin") {
      this.cachedUserAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVersion}.0.0.0 Safari/537.36`;
    } else if (process.platform === "win32") {
      this.cachedUserAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVersion}.0.0.0 Safari/537.36`;
    } else {
      this.cachedUserAgent = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVersion}.0.0.0 Safari/537.36`;
    }
    console.log(`\u{1F50D} ChromiumVersionHelper: Generated User-Agent with Chrome/${majorVersion}`);
    return this.cachedUserAgent;
  }
  /**
   * Constructs the path to the custom Kowalski browser executable
   * Dynamically uses the latest installed revision
   */
  static getCustomExecutablePath() {
    const userHome = import_electron.app.getPath("home");
    const revision = this.getLatestRevision();
    if (process.platform === "darwin") {
      return import_path.default.join(
        userHome,
        `Library/Caches/ms-playwright/chromium-${revision}/chrome-mac-arm64/Kowalski.app/Contents/MacOS/Google Chrome for Testing`
      );
    } else if (process.platform === "win32") {
      return import_path.default.join(
        userHome,
        `AppData/Local/ms-playwright/chromium-${revision}/chrome-win/Kowalski.exe`
      );
    } else {
      return import_path.default.join(
        userHome,
        `.cache/ms-playwright/chromium-${revision}/chrome-linux/Kowalski`
      );
    }
  }
  /**
   * Clears all cached values (useful for testing or forced refresh)
   */
  static clearCache() {
    this.cachedVersion = null;
    this.cachedRevision = null;
    this.cachedUserAgent = null;
  }
};

// src/main/services/BrowserManager.ts
var stealth = (0, import_puppeteer_extra_plugin_stealth.default)();
stealth.enabledEvasions.add("chrome.app");
stealth.enabledEvasions.add("chrome.csi");
stealth.enabledEvasions.add("chrome.loadTimes");
stealth.enabledEvasions.add("chrome.runtime");
stealth.enabledEvasions.add("iframe.contentWindow");
stealth.enabledEvasions.add("media.codecs");
stealth.enabledEvasions.add("navigator.hardwareConcurrency");
stealth.enabledEvasions.add("navigator.languages");
stealth.enabledEvasions.add("navigator.permissions");
stealth.enabledEvasions.add("navigator.plugins");
stealth.enabledEvasions.add("navigator.vendor");
stealth.enabledEvasions.add("navigator.webdriver");
stealth.enabledEvasions.add("sourceurl");
stealth.enabledEvasions.add("user-agent-override");
stealth.enabledEvasions.add("webgl.vendor");
stealth.enabledEvasions.add("window.outerdimensions");
import_playwright_extra.chromium.use(stealth);
var BrowserManager = class _BrowserManager {
  static instance;
  browserContext = null;
  constructor() {
  }
  static getInstance() {
    if (!_BrowserManager.instance) {
      _BrowserManager.instance = new _BrowserManager();
    }
    return _BrowserManager.instance;
  }
  /**
   * Launches a persistent browser context.
   * If an instance is already running, it closes it first to prevent zombies.
   */
  async launch(config = { headless: true }) {
    if (this.browserContext) {
      console.log("\u267B\uFE0F BrowserManager: Closing existing instance before launch...");
      await this.close();
    }
    try {
      const userDataPath = import_electron2.app.getPath("userData");
      const persistentContextPath = import_path2.default.join(userDataPath, "kowalski_browser");
      console.log(`\u{1F680} BrowserManager: Launching Persistent Context at: ${persistentContextPath}`);
      console.log(`   Headless: ${config.headless}`);
      const extraArgs = [];
      if (config.bounds) {
        extraArgs.push(`--app=https://www.instagram.com/accounts/login/`);
        extraArgs.push("--frameless");
        extraArgs.push("--always-on-top");
        extraArgs.push(`--window-position=${config.bounds.x},${config.bounds.y}`);
        extraArgs.push(`--window-size=${config.bounds.width},${config.bounds.height}`);
      }
      const customExecutablePath = ChromiumVersionHelper.getCustomExecutablePath();
      let executablePath = "";
      if (import_fs2.default.existsSync(customExecutablePath)) {
        console.log("\u{1F575}\uFE0F\u200D\u2640\uFE0F BrowserManager: Using Custom Stealth Browser:", customExecutablePath);
        executablePath = customExecutablePath;
      } else {
        console.warn("\u26A0\uFE0F BrowserManager: Custom browser not found. Using default.");
      }
      const systemTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      this.browserContext = await import_playwright_extra.chromium.launchPersistentContext(persistentContextPath, {
        headless: config.headless,
        executablePath: executablePath || void 0,
        viewport: null,
        // Let window size dictate viewport
        // Dynamic User-Agent that matches actual Chromium version (auto-detected)
        userAgent: ChromiumVersionHelper.generateUserAgent(),
        // Fingerprint consistency options
        locale: "en-US",
        timezoneId: systemTimezone,
        colorScheme: "light",
        deviceScaleFactor: 2,
        // Retina Mac
        // HTTP headers that Chrome normally sends
        extraHTTPHeaders: {
          "Accept-Language": "en-US,en;q=0.9"
        },
        args: [
          "--disable-blink-features=AutomationControlled",
          // Mask WebDriver
          "--disable-infobars",
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--disable-gpu",
          // Often helps stability in headless envs
          ...extraArgs
        ],
        // Accept downloads if needed later
        acceptDownloads: true
      });
      await this.browserContext.addInitScript(() => {
        const getParameterProto = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(parameter) {
          if (parameter === 37445) {
            return "Intel Inc.";
          }
          if (parameter === 37446) {
            return "Intel Iris OpenGL Engine";
          }
          return getParameterProto.call(this, parameter);
        };
        const getParameterProto2 = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = function(parameter) {
          if (parameter === 37445) {
            return "Intel Inc.";
          }
          if (parameter === 37446) {
            return "Intel Iris OpenGL Engine";
          }
          return getParameterProto2.call(this, parameter);
        };
      });
      try {
        const sessionPath = import_path2.default.join(userDataPath, "session.json");
        if (import_fs2.default.existsSync(sessionPath)) {
          console.log("\u{1F36A} BrowserManager: Found session.json from Onboarding. Injecting cookies...");
          const sessionData = JSON.parse(import_fs2.default.readFileSync(sessionPath, "utf-8"));
          if (sessionData && Array.isArray(sessionData.cookies)) {
            await this.browserContext.addCookies(sessionData.cookies);
            console.log(`\u2705 BrowserManager: Injected ${sessionData.cookies.length} cookies from session.json`);
          }
        }
      } catch (err) {
        console.error("\u26A0\uFE0F BrowserManager: Failed to sync session.json cookies:", err);
      }
      this.browserContext.on("close", () => {
        console.log("\u274C BrowserManager: Context closed unexpectedly (or manually). Clearing reference.");
        this.browserContext = null;
      });
      return this.browserContext;
    } catch (error) {
      console.error("\u{1F525} BrowserManager: Failed to launch browser:", error);
      this.browserContext = null;
      throw error;
    }
  }
  /**
   * Safely closes the current browser instance.
   */
  async close() {
    if (!this.browserContext) return;
    try {
      console.log("\u{1F6D1} BrowserManager: Closing browser...");
      await this.browserContext.close();
    } catch (error) {
      console.error("\u26A0\uFE0F BrowserManager: Error during close (likely already closed):", error);
    } finally {
      this.browserContext = null;
    }
  }
  /**
   * NUCLEAR OPTION: Closes the browser and WIPES the persistent profile directory.
   * Used for "Reset All" functionality.
   */
  async clearData() {
    console.log("\u2622\uFE0F BrowserManager: Initiating Data Wipe...");
    await this.close();
    try {
      const userDataPath = import_electron2.app.getPath("userData");
      const persistentContextPath = import_path2.default.join(userDataPath, "kowalski_browser");
      if (import_fs2.default.existsSync(persistentContextPath)) {
        import_fs2.default.rmSync(persistentContextPath, { recursive: true, force: true });
        console.log("\u2705 BrowserManager: Wiped kowalski_browser directory.");
      } else {
        console.log("\u2139\uFE0F BrowserManager: No directory to wipe.");
      }
    } catch (error) {
      console.error("\u274C BrowserManager: Failed to wipe data:", error);
    }
  }
  /**
   * Launches a frameless overlay for login, locked to the UI.
   */
  async login(bounds, mainWindow2) {
    console.log("\u{1F510} BrowserManager: Starting Single Vehicle Login Overlay...");
    mainWindow2.setMovable(false);
    try {
      const context = await this.launch({ headless: false, bounds });
      const pages = context.pages();
      const page = pages.length > 0 ? pages[0] : await context.newPage();
      context.on("page", async (newPage) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const allPages = context.pages();
        if (allPages.length > 1) {
          console.log("\u{1F6AB} BrowserManager: Blocked attempt to open new window.");
          try {
            await newPage.close();
          } catch (e) {
          }
        }
      });
      console.log("\u{1F30D} Waiting for Instagram Login page to be ready...");
      try {
        await page.waitForLoadState("domcontentloaded", { timeout: 1e4 });
      } catch (e) {
        console.log("\u26A0\uFE0F Page load state wait timed out, continuing anyway...");
      }
      try {
        console.log("\u23F3 Waiting for user to complete login...");
        await page.waitForSelector('svg[aria-label="Home"]', { timeout: 3e5 });
        console.log("\u2705 INSTAGRAM LOGIN CONFIRMED (Overlay)");
        await this.close();
        mainWindow2.setMovable(true);
        return true;
      } catch (e) {
        console.log("\u274C Login/Timeout failed.");
        throw e;
      }
    } catch (error) {
      console.error("\u26A0\uFE0F Login Overlay Failed/Cancelled:", error);
      await this.close();
      mainWindow2.setMovable(true);
      return false;
    }
  }
  /**
   * Returns the current active context, or null if not running.
   */
  getContext() {
    return this.browserContext;
  }
};

// src/main/services/SecureKeyManager.ts
var import_electron3 = require("electron");
var SecureKeyManager = class _SecureKeyManager {
  static instance;
  constructor() {
  }
  static getInstance() {
    if (!_SecureKeyManager.instance) {
      _SecureKeyManager.instance = new _SecureKeyManager();
    }
    return _SecureKeyManager.instance;
  }
  // Helper to dynamically load electron-store (ESM)
  async getStore() {
    const { default: Store } = await import("electron-store");
    return new Store();
  }
  /**
   * Encrypts and saves the API key to disk.
   */
  async setKey(apiKey) {
    if (!import_electron3.safeStorage.isEncryptionAvailable()) {
      console.error("SafeStorage encryption is not available.");
      return false;
    }
    try {
      const buffer = import_electron3.safeStorage.encryptString(apiKey);
      const store = await this.getStore();
      store.set("secure.openaiApiKey", buffer.toString("hex"));
      return true;
    } catch (error) {
      console.error("Failed to encrypt API key:", error);
      return false;
    }
  }
  /**
   * Retrieves and decrypts the API key.
   * Returns null if missing or decryption fails.
   */
  async getKey() {
    if (!import_electron3.safeStorage.isEncryptionAvailable()) return null;
    try {
      const store = await this.getStore();
      const hex = store.get("secure.openaiApiKey");
      if (!hex) return null;
      const buffer = Buffer.from(hex, "hex");
      return import_electron3.safeStorage.decryptString(buffer);
    } catch (error) {
      console.error("Decryption failed, treating key as missing:", error);
      return null;
    }
  }
  /**
   * Checks the status of the key without exposing it.
   */
  async getKeyStatus() {
    if (!import_electron3.safeStorage.isEncryptionAvailable()) {
      return "locked";
    }
    try {
      const store = await this.getStore();
      const hex = store.get("secure.openaiApiKey");
      if (!hex) {
        return "missing";
      }
      return "secured";
    } catch (error) {
      console.error("Error checking key status:", error);
      return "missing";
    }
  }
};

// src/main/services/UsageService.ts
var MODEL_RATES = {
  INPUT_TOKEN: 25e-7,
  // $2.50 / 1M
  CACHED_INPUT_TOKEN: 125e-8,
  // $1.25 / 1M
  OUTPUT_TOKEN: 1e-5
  // $10.00 / 1M
};
var UsageService = class _UsageService {
  static instance;
  constructor() {
  }
  static getInstance() {
    if (!_UsageService.instance) {
      _UsageService.instance = new _UsageService();
    }
    return _UsageService.instance;
  }
  // Helper to dynamically load electron-store (ESM)
  async getStore() {
    const { default: Store } = await import("electron-store");
    return new Store();
  }
  /**
   * Initializes usage data if not present.
   * Performs monthly reset check on startup.
   */
  async initialize() {
    const store = await this.getStore();
    const usage = store.get("usageData");
    if (!usage) {
      const initial = {
        currentMonthSpend: 0,
        lastResetDate: (/* @__PURE__ */ new Date()).toISOString()
      };
      store.set("usageData", initial);
      return;
    }
    await this.checkMonthlyReset();
  }
  /**
   * Resets spending if we have entered a new month relative to lastResetDate.
   */
  async checkMonthlyReset() {
    const store = await this.getStore();
    const usage = store.get("usageData");
    if (!usage) return;
    const lastDate = new Date(usage.lastResetDate);
    const now = /* @__PURE__ */ new Date();
    if (lastDate.getMonth() !== now.getMonth() || lastDate.getFullYear() !== now.getFullYear()) {
      console.log("\u{1F5D3}\uFE0F Monthly Usage Reset Triggered.");
      const resetData = {
        currentMonthSpend: 0,
        lastResetDate: now.toISOString()
      };
      store.set("usageData", resetData);
    }
  }
  /**
   * Calculates estimated cost for Vision requests (Pre-flight).
   * Returns cost in Dollars (e.g., 0.0005)
   */
  calculateVisionCost(width, height, detail = "high") {
    let tokens = 0;
    if (detail === "low") {
      tokens = 85;
    } else {
      let scaledWidth = width;
      let scaledHeight = height;
      if (scaledWidth > 2048 || scaledHeight > 2048) {
        const ratio = Math.min(2048 / scaledWidth, 2048 / scaledHeight);
        scaledWidth = Math.floor(scaledWidth * ratio);
        scaledHeight = Math.floor(scaledHeight * ratio);
      }
      const shortestSide = Math.min(scaledWidth, scaledHeight);
      const scaleFactor = 768 / shortestSide;
      scaledWidth = Math.floor(scaledWidth * scaleFactor);
      scaledHeight = Math.floor(scaledHeight * scaleFactor);
      const tilesX = Math.ceil(scaledWidth / 512);
      const tilesY = Math.ceil(scaledHeight / 512);
      const totalTiles = tilesX * tilesY;
      tokens = 85 + 170 * totalTiles;
    }
    return tokens * MODEL_RATES.INPUT_TOKEN;
  }
  /**
   * Adds actual API usage to the accumulator.
   */
  async incrementUsage(usage) {
    const cached = usage.prompt_tokens_details?.cached_tokens || 0;
    const regularInput = Math.max(0, usage.prompt_tokens - cached);
    const output = usage.completion_tokens || 0;
    const cost = regularInput * MODEL_RATES.INPUT_TOKEN + cached * MODEL_RATES.CACHED_INPUT_TOKEN + output * MODEL_RATES.OUTPUT_TOKEN;
    const store = await this.getStore();
    const currentData = store.get("usageData");
    const currentSpend = currentData?.currentMonthSpend || 0;
    const lastReset = currentData?.lastResetDate || (/* @__PURE__ */ new Date()).toISOString();
    const newSpend = currentSpend + cost;
    store.set("usageData", {
      currentMonthSpend: newSpend,
      lastResetDate: lastReset
    });
    console.log(`\u{1F4B0} Usage Added: $${cost.toFixed(6)} | Total: $${newSpend.toFixed(4)}`);
    return newSpend;
  }
  /**
   * Checks if current spending + estimated cost exceeds the cap.
   */
  async isOverBudget(cap, estimatedCost = 0) {
    const store = await this.getStore();
    const usage = store.get("usageData");
    const current = usage?.currentMonthSpend || 0;
    return current + estimatedCost >= cap;
  }
  /**
   * Returns current usage data.
   */
  async getUsage() {
    const store = await this.getStore();
    return store.get("usageData") || { currentMonthSpend: 0, lastResetDate: (/* @__PURE__ */ new Date()).toISOString() };
  }
};

// src/main/services/SchedulerService.ts
var import_electron4 = require("electron");
var import_fs3 = __toESM(require("fs"), 1);
var import_path3 = __toESM(require("path"), 1);
var import_child_process = require("child_process");

// src/main/services/LoremIpsumGenerator.ts
var LoremIpsumGenerator = class {
  static TITLES = [
    "The Digital Frontier",
    "Silicon Valley Morning",
    "The Cupertino Dispatch",
    "Tech & Culture Weekly",
    "The Midnight Protocol",
    "Future Tense",
    "The Analog Revival"
  ];
  static SUBTITLES = [
    "Exploring the intersection of humanity and algorithms.",
    "A deep dive into the week's events and their impact.",
    "Why the next big thing might be smaller than you think.",
    "Reflections on privacy, connection, and the digital self.",
    "Navigating the noise of the information age."
  ];
  static HEADINGS = [
    "The AI Revolution",
    "Market Shifts",
    "Global Perspectives",
    "Design Patterns",
    "Community & Core",
    "The New Normal",
    "Sustainable Futures"
  ];
  static PARAGRAPHS = [
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.",
    "Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.",
    "Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo.",
    "At vero eos et accusamus et iusto odio dignissimos ducimus qui blanditiis praesentium voluptatum deleniti atque corrupti quos dolores et quas molestias excepturi sint occaecati cupiditate non provident.",
    "Nam libero tempore, cum soluta nobis est eligendi optio cumque nihil impedit quo minus id quod maxime placeat facere possimus, omnis voluptas assumenda est, omnis dolor repellendus."
  ];
  static getRandom(array) {
    return array[Math.floor(Math.random() * array.length)];
  }
  static generateSection() {
    const numParagraphs = Math.floor(Math.random() * 3) + 1;
    const content = [];
    for (let i = 0; i < numParagraphs; i++) {
      content.push(this.getRandom(this.PARAGRAPHS));
    }
    return {
      heading: this.getRandom(this.HEADINGS),
      content
    };
  }
  static generate(options) {
    const numSections = Math.floor(Math.random() * 2) + 2;
    const sections = [];
    for (let i = 0; i < numSections; i++) {
      sections.push(this.generateSection());
    }
    const date = options?.targetDate ? new Date(options.targetDate) : /* @__PURE__ */ new Date();
    const dayName = date.toLocaleDateString("en-US", { weekday: "long" });
    let title = `The ${dayName} Analysis`;
    if (options?.userName && options.userName.trim().length > 0) {
      const name = options.userName.trim();
      title = `${name}'s ${dayName} Analysis`;
    }
    const location = options?.location || "";
    return {
      title,
      subtitle: this.getRandom(this.SUBTITLES),
      date: date.toISOString(),
      location,
      scheduledTime: options?.scheduledTime || "8:00 AM",
      sections
    };
  }
};

// src/main/services/SchedulerService.ts
var SchedulerService = class _SchedulerService {
  static instance;
  checkInterval = null;
  mainWindow = null;
  alignmentTimeout = null;
  lastWakeTime = /* @__PURE__ */ new Date();
  // Track when app started/woke
  suspensionBlockerId = null;
  constructor() {
  }
  static getInstance() {
    if (!_SchedulerService.instance) {
      _SchedulerService.instance = new _SchedulerService();
    }
    return _SchedulerService.instance;
  }
  getLastWakeTime() {
    return this.lastWakeTime;
  }
  setMainWindow(window) {
    this.mainWindow = window;
  }
  // Helper to dynamically load electron-store (ESM)
  async getStore() {
    const { default: Store } = await import("electron-store");
    return new Store();
  }
  // Format date in LOCAL timezone (avoids UTC conversion issues)
  formatLocalDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    if (this.alignmentTimeout) {
      clearTimeout(this.alignmentTimeout);
      this.alignmentTimeout = null;
    }
    this.disableInsomnia();
  }
  async initialize() {
    console.log("\u23F0 SchedulerService: Initialized.");
    this.lastWakeTime = /* @__PURE__ */ new Date();
    console.log("\u23F0 Wake Time set to:", this.lastWakeTime.toLocaleString());
    this.suspensionBlockerId = import_electron4.powerSaveBlocker.start("prevent-app-suspension");
    console.log(`\u{1F50B} Power Save Blocker active (ID: ${this.suspensionBlockerId})`);
    this.startHeartbeat();
    import_electron4.powerMonitor.on("resume", () => {
      console.log(`\u26A1\uFE0F System Resumed. Heartbeat active. App Uptime: ${Math.floor(process.uptime() / 60)}m. Last Wake (Start) Time: ${this.lastWakeTime.toLocaleString()}`);
      this.startHeartbeat();
    });
  }
  startHeartbeat() {
    if (this.checkInterval) clearInterval(this.checkInterval);
    if (this.alignmentTimeout) clearTimeout(this.alignmentTimeout);
    this.handleInsomniaState();
    import_electron4.powerMonitor.on("on-ac", () => {
      console.log("\u{1F50C} Power Source: AC. Re-evaluating Insomnia Mode...");
      this.handleInsomniaState();
    });
    import_electron4.powerMonitor.on("on-battery", () => {
      console.log("\u{1FAAB} Power Source: Battery. Disabling Insomnia Mode...");
      this.disableInsomnia();
    });
    const now = /* @__PURE__ */ new Date();
    const msUntilNextMinute = 6e4 - now.getTime() % 6e4;
    this.checkSchedule();
    this.alignmentTimeout = setTimeout(() => {
      this.checkSchedule();
      this.checkInterval = setInterval(() => {
        this.checkSchedule();
      }, 6e4);
    }, msUntilNextMinute);
  }
  // --- INSOMNIA MANAGEMENT ---
  insomniaProcess = null;
  // Type 'ChildProcess' needs import or 'any'
  handleInsomniaState() {
    if (!import_electron4.powerMonitor.isOnBatteryPower()) {
      this.enableInsomnia();
    } else {
      this.disableInsomnia();
    }
  }
  enableInsomnia() {
    if (this.insomniaProcess) return;
    console.log("\u{1F50B} AC Power detected: Insomnia Mode active (Preventing System Sleep)");
    this.insomniaProcess = (0, import_child_process.spawn)("caffeinate", ["-i", "-s", "-w", process.pid.toString()]);
    this.insomniaProcess.on("close", (code) => {
      console.log(`\u2615\uFE0F Insomnia Process exited with code ${code}`);
      this.insomniaProcess = null;
    });
  }
  disableInsomnia() {
    if (this.insomniaProcess) {
      console.log("\u{1FAAB} Battery detected / Stopping: Insomnia Mode disabled");
      this.insomniaProcess.kill();
      this.insomniaProcess = null;
    }
  }
  // ---------------------------
  /**
   * Ensures the daily schedule snapshot is up-to-date.
   * - On first run after onboarding: Creates snapshot with activeDate = TOMORROW
   * - On new calendar day: Refreshes snapshot from current settings
   * - Otherwise: Returns existing snapshot
   */
  async ensureDailySnapshot(store) {
    const settings = store.get("settings") || {};
    if (!settings.hasOnboarded) {
      return null;
    }
    const today = this.formatLocalDate(/* @__PURE__ */ new Date());
    let activeSchedule = store.get("activeSchedule");
    if (!activeSchedule) {
      const canHitToday = this.canScheduleForToday(settings.morningTime || "8:00 AM");
      const nextDate = /* @__PURE__ */ new Date();
      if (!canHitToday) {
        nextDate.setDate(nextDate.getDate() + 1);
      }
      const activeDateStr = this.formatLocalDate(nextDate);
      activeSchedule = {
        morningTime: settings.morningTime || "8:00 AM",
        eveningTime: settings.eveningTime || "4:00 PM",
        digestFrequency: settings.digestFrequency || 1,
        activeDate: activeDateStr
      };
      store.set("activeSchedule", activeSchedule);
      console.log(`\u{1F4C5} First Daily Snapshot Created. Active starting ${activeDateStr}:`, activeSchedule);
      this.mainWindow?.webContents.send("schedule-updated", activeSchedule);
      return activeSchedule;
    }
    if (activeSchedule.activeDate !== today && activeSchedule.activeDate < today) {
      activeSchedule = {
        morningTime: settings.morningTime || "8:00 AM",
        eveningTime: settings.eveningTime || "4:00 PM",
        digestFrequency: settings.digestFrequency || 1,
        activeDate: today
      };
      store.set("activeSchedule", activeSchedule);
      console.log(`\u{1F4C5} Daily Snapshot Refreshed for ${today}:`, activeSchedule);
      this.mainWindow?.webContents.send("schedule-updated", activeSchedule);
    }
    return activeSchedule;
  }
  async checkSchedule() {
    try {
      const store = await this.getStore();
      const activeSchedule = await this.ensureDailySnapshot(store);
      if (!activeSchedule) {
        return;
      }
      const settings = store.get("settings") || {};
      const now = /* @__PURE__ */ new Date();
      const todayStr = this.formatLocalDate(now);
      if (activeSchedule.activeDate !== todayStr) {
        return;
      }
      this.mainWindow?.webContents.send("schedule-updated", activeSchedule);
      if (this.shouldTrigger(now, activeSchedule.morningTime, settings.lastAnalysisDate)) {
        console.log(`\u{1F680} Scheduling Trigger (Morning: ${activeSchedule.morningTime})`);
        await this.triggerSimulation(now, store, activeSchedule.morningTime);
        return;
      }
      if (activeSchedule.digestFrequency === 2 && this.shouldTrigger(now, activeSchedule.eveningTime, settings.lastAnalysisDate)) {
        console.log(`\u{1F680} Scheduling Trigger (Evening: ${activeSchedule.eveningTime})`);
        await this.triggerSimulation(now, store, activeSchedule.eveningTime);
        return;
      }
    } catch (error) {
      console.error("Scheduler Check Failed:", error);
    }
  }
  // catchUpMissedSlots removed for Daemon Mode (Anti-Burst)
  /**
   * Helper to determine if a slot is still viable for TODAY based on time and buffer.
   */
  canScheduleForToday(targetTimeStr) {
    const now = /* @__PURE__ */ new Date();
    const [time, modifier] = targetTimeStr.split(" ");
    let [hours, minutes] = time.split(":").map(Number);
    if (modifier === "PM" && hours < 12) hours += 12;
    if (modifier === "AM" && hours === 12) hours = 0;
    const targetDate = new Date(now);
    targetDate.setHours(hours, minutes, 0, 0);
    if (now >= targetDate) return false;
    const prepTimeMs = targetDate.getTime() - this.lastWakeTime.getTime();
    const threeHoursMs = 15 * 1e3;
    const uptimeSeconds = process.uptime();
    const threeHoursSeconds = 15;
    if (prepTimeMs < threeHoursMs && uptimeSeconds < threeHoursSeconds) {
      console.log(`\u{1F6E1}\uFE0F Initial Snapshot: Skipping Today. Too close to wake/boot. (${Math.floor(uptimeSeconds)}s uptime)`);
      return false;
    }
    return true;
  }
  /**
   * Determines if we should trigger based on current time, target time, and last run.
   * Logic: 
   * 1. Parse target time (e.g., "8:00 AM") into a Date object for TODAY.
   * 2. If NOW is >= Target Time AND Last Run was BEFORE Target Time (or never), then TRIGGER.
   * 3. Tolerance: Only trigger if within 12 hours of the missed slot to avoid ancient catch-ups.
   */
  shouldTrigger(now, targetTimeStr, lastRunIso) {
    if (!targetTimeStr) return false;
    const [time, modifier] = targetTimeStr.split(" ");
    let [hours, minutes] = time.split(":").map(Number);
    if (modifier === "PM" && hours < 12) hours += 12;
    if (modifier === "AM" && hours === 12) hours = 0;
    const targetTimeToday = new Date(now);
    targetTimeToday.setHours(hours, minutes, 0, 0);
    if (now < targetTimeToday) return false;
    const prepTimeMs = targetTimeToday.getTime() - this.lastWakeTime.getTime();
    const threeHoursMs = 15 * 1e3;
    const uptimeSeconds = process.uptime();
    const threeHoursSeconds = 15;
    if (prepTimeMs < threeHoursMs && uptimeSeconds < threeHoursSeconds) {
      console.log(`\u{1F6E1}\uFE0F Skipping Slot ${targetTimeStr}: Not enough prep time (DateDiff: ${Math.floor(prepTimeMs / 6e4)}m, Uptime: ${Math.floor(uptimeSeconds / 60)}m < 180m)`);
      return false;
    }
    if (lastRunIso) {
      const lastRun = new Date(lastRunIso);
      if (lastRun.getTime() >= targetTimeToday.getTime()) {
        return false;
      }
    }
    const diffMs = now.getTime() - targetTimeToday.getTime();
    const thirtyMinutesMs = 30 * 60 * 1e3;
    if (diffMs > thirtyMinutesMs) {
      return false;
    }
    return true;
  }
  async triggerSimulation(now, store, scheduledTime, targetDate, silent = false) {
    const settings = store.get("settings") || {};
    const effectiveDate = targetDate || now;
    const mockAnalysis = LoremIpsumGenerator.generate({
      userName: settings.userName,
      location: settings.location,
      scheduledTime,
      targetDate: effectiveDate
    });
    console.log(`\u{1F311} Background Task Started at ${(/* @__PURE__ */ new Date()).toLocaleString()}`);
    const newRecord = {
      id: `analysis-sim-${Date.now()}-${Math.floor(Math.random() * 1e3)}`,
      // Random suffix to avoid collision in fast loops
      data: mockAnalysis,
      leadStoryPreview: mockAnalysis.sections[0]?.content[0]?.substring(0, 100) + "..." || "No preview available."
    };
    const userDataPath = import_electron4.app.getPath("userData");
    const recordDir = import_path3.default.join(userDataPath, "analysis_records");
    const recordPath = import_path3.default.join(recordDir, `${newRecord.id}.json`);
    const tempPath = import_path3.default.join(recordDir, `${newRecord.id}.tmp`);
    try {
      await import_fs3.default.promises.writeFile(tempPath, JSON.stringify(newRecord, null, 2));
      await import_fs3.default.promises.rename(tempPath, recordPath);
      console.log(`\u{1F4BE} Saved Full Analysis cleanly to disk: ${recordPath}`);
      const metadataRecord = {
        id: newRecord.id,
        // Keep critical fields for sorting/listing
        data: {
          date: newRecord.data.date,
          // Used for sorting
          title: newRecord.data.title,
          scheduledTime: newRecord.data.scheduledTime,
          location: newRecord.data.location
          // REMOVED: sections (heavy text)
        },
        leadStoryPreview: newRecord.leadStoryPreview
      };
      const currentAnalyses = store.get("analyses") || [];
      const updatedAnalyses = [metadataRecord, ...currentAnalyses];
      store.set("analyses", updatedAnalyses);
      const newStatus = silent ? "idle" : "ready";
      store.set("settings", {
        ...settings,
        lastAnalysisDate: effectiveDate.toISOString(),
        analysisStatus: newStatus
      });
      console.log(`\u{1F315} Background Task Completed at ${(/* @__PURE__ */ new Date()).toLocaleString()}`);
      console.log(`\u{1F916} Simulation Complete (${silent ? "Silent/Historical" : "Live"}). Estimated Cost: $0.00`);
      if (!silent && this.mainWindow && !this.mainWindow.isDestroyed()) {
        console.log("\u{1F4E1} Push Notification Sent: analysis-ready (Metadata Only)");
        this.mainWindow.webContents.send("analysis-ready", metadataRecord);
      }
    } catch (e) {
      console.error("\u274C Failed to save analysis to disk (Atomic Write Failed). Aborting metadata update.", e);
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send("analysis-error", { message: "Failed to save analysis to disk." });
      }
      try {
        if (import_fs3.default.existsSync(tempPath)) await import_fs3.default.promises.unlink(tempPath);
      } catch (cleanupErr) {
      }
      return;
    }
  }
};

// src/main/main.ts
var import_module = require("module");
import_electron5.app.commandLine.appendSwitch("ignore-certificate-errors");
import_electron5.app.commandLine.appendSwitch("disable-gpu");
import_electron5.app.commandLine.appendSwitch("disable-software-rasterizer");
import_electron5.app.commandLine.appendSwitch("disable-dev-shm-usage");
import_electron5.app.commandLine.appendSwitch("disable-renderer-backgrounding");
var __filename = (0, import_url.fileURLToPath)(void 0);
var __dirname = import_path4.default.dirname(__filename);
var require2 = (0, import_module.createRequire)(void 0);
if (!import_electron5.app.getLoginItemSettings().openAtLogin) {
  import_electron5.app.setLoginItemSettings({
    openAtLogin: true,
    openAsHidden: false
    // Optional: could be true if we want silent start
  });
}
if (require2("electron-squirrel-startup")) {
  import_electron5.app.quit();
}
var isQuitting = false;
var mainWindow = null;
var SHARED_PARTITION = "persist:instagram_shared";
var createWindow = () => {
  const width = 1280 + Math.floor(Math.random() * 100);
  const height = 800 + Math.floor(Math.random() * 100);
  mainWindow = new import_electron5.BrowserWindow({
    width,
    height,
    title: "Kowalski",
    backgroundColor: "#F9F8F5",
    // Warm Alabaster for LCD antialiasing
    frame: true,
    // titleBarStyle property removed to use system default
    webPreferences: {
      preload: import_path4.default.join(__dirname, "../preload/preload.cjs"),
      webviewTag: true,
      partition: SHARED_PARTITION
      // Force main window to check this (though webview usually isolates)
    },
    // Set icon for Windows/Linux (and Mac if packaged)
    // Use the processed, standardized icon
    icon: import_path4.default.join(__dirname, "../../build/icon-standard.png")
  });
  if (process.platform === "darwin" && process.env.VITE_DEV_SERVER_URL) {
    const iconPath = import_path4.default.join(__dirname, "../../build/icon-standard.png");
    import_electron5.app.dock?.setIcon(iconPath);
  }
  SchedulerService.getInstance().setMainWindow(mainWindow);
  mainWindow.on("page-title-updated", (e) => {
    e.preventDefault();
  });
  if (process.env.VITE_DEV_SERVER_URL) {
    const url = process.env.VITE_DEV_SERVER_URL;
    console.log("Creating window with URL:", url);
    mainWindow.loadURL(url);
  } else {
    const filePath = import_path4.default.join(__dirname, "../dist/index.html");
    console.log("Loading file path:", filePath);
    mainWindow.loadFile(filePath);
  }
  mainWindow.webContents.on("did-finish-load", () => {
    console.log("\u2705 did-finish-load: Main window content loaded successfully.");
  });
  mainWindow.webContents.on("did-fail-load", (event, errorCode, errorDescription, validatedURL) => {
    console.error(`\u274C did-fail-load: Error ${errorCode} (${errorDescription}) loading ${validatedURL}`);
  });
  mainWindow.webContents.on("dom-ready", () => {
    console.log("\u2705 dom-ready: DOM is ready.");
  });
  mainWindow.webContents.on("render-process-gone", (event, details) => {
    console.error(`\u{1F480} render-process-gone: Reason: ${details.reason}, Exit Code: ${details.exitCode}`);
  });
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
      return false;
    }
    SchedulerService.getInstance().setMainWindow(null);
  });
};
import_electron5.app.on("ready", () => {
  createWindow();
  console.log("Session persistence enabled.");
  console.log("Session persistence enabled.");
  UsageService.getInstance().initialize();
  SchedulerService.getInstance().initialize();
  const userDataPath = import_electron5.app.getPath("userData");
  const recordsPath = import_path4.default.join(userDataPath, "analysis_records");
  if (!import_fs4.default.existsSync(recordsPath)) {
    import_fs4.default.mkdirSync(recordsPath, { recursive: true });
    console.log("\u{1F4C2} Created analysis_records directory");
  }
  setupIPCHandlers();
});
import_electron5.app.on("before-quit", () => {
  isQuitting = true;
  SchedulerService.getInstance().stop();
});
function setupIPCHandlers() {
  import_electron5.ipcMain.handle("reset-session", async () => {
    console.log("\u{1F9F9} Starting session reset...");
    try {
      const userDataPath = import_electron5.app.getPath("userData");
      const sessionPath = import_path4.default.join(userDataPath, "session.json");
      if (import_fs4.default.existsSync(sessionPath)) {
        import_fs4.default.unlinkSync(sessionPath);
        console.log("\u2705 Deleted legacy session.json");
      }
      await BrowserManager.getInstance().clearData();
    } catch (e) {
      console.error("\u26A0\uFE0F Failed to delete session.json:", e);
    }
    try {
      await import_electron5.session.defaultSession.clearStorageData();
      console.log("\u2705 Cleared default session storage");
    } catch (e) {
      console.error("\u26A0\uFE0F Failed to clear default session storage:", e);
    }
    try {
      await import_electron5.session.fromPartition(SHARED_PARTITION).clearStorageData();
      console.log("\u2705 Cleared shared partition storage");
    } catch (e) {
      console.error("\u26A0\uFE0F Failed to clear shared partition storage:", e);
    }
    try {
      const { default: Store } = await import("electron-store");
      const store = new Store();
      store.clear();
      store.delete("analyses");
      store.delete("settings");
      store.delete("activeSchedule");
      console.log("\u2705 Cleared electron-store");
    } catch (e) {
      console.error("\u274C Failed to clear electron-store:", e);
      return false;
    }
    console.log("\u{1F389} Session reset complete");
    return true;
  });
  import_electron5.ipcMain.handle("settings:get", async () => {
    const { default: Store } = await import("electron-store");
    const store = new Store();
    return store.get("settings") || {};
  });
  import_electron5.ipcMain.handle("settings:set", async (_event, newSettings) => {
    const { default: Store } = await import("electron-store");
    const store = new Store();
    store.set("settings", newSettings);
    if (newSettings.hasOnboarded === false) {
      store.delete("activeSchedule");
      console.log("\u{1F9F9} Cleared activeSchedule during reset");
    } else if (newSettings.hasOnboarded === true) {
      const activeSchedule = store.get("activeSchedule");
      if (activeSchedule) {
        const updatedSchedule = {
          ...activeSchedule,
          morningTime: newSettings.morningTime,
          eveningTime: newSettings.eveningTime,
          digestFrequency: newSettings.digestFrequency
        };
        store.set("activeSchedule", updatedSchedule);
        const windows = import_electron5.BrowserWindow.getAllWindows();
        windows.forEach((win) => {
          win.webContents.send("schedule-updated", updatedSchedule);
        });
        console.log("\u{1F525} Hot-Patched Daily Snapshot with new User Settings:", updatedSchedule);
      }
    }
    return true;
  });
  import_electron5.ipcMain.handle("settings:patch", async (_event, updates) => {
    const { default: Store } = await import("electron-store");
    const store = new Store();
    const current = store.get("settings") || {};
    const merged = { ...current, ...updates };
    store.set("settings", merged);
    if ("morningTime" in updates || "eveningTime" in updates || "digestFrequency" in updates) {
      const activeSchedule = store.get("activeSchedule");
      if (activeSchedule) {
        const updatedSchedule = {
          ...activeSchedule,
          morningTime: merged.morningTime,
          eveningTime: merged.eveningTime,
          digestFrequency: merged.digestFrequency
        };
        store.set("activeSchedule", updatedSchedule);
        import_electron5.BrowserWindow.getAllWindows().forEach((win) => {
          win.webContents.send("schedule-updated", updatedSchedule);
        });
        console.log("\u{1F525} Hot-Patched Daily Snapshot (via Patch):", updatedSchedule);
      }
    }
    return merged;
  });
  import_electron5.ipcMain.handle("analyses:get", async () => {
    const { default: Store } = await import("electron-store");
    const store = new Store();
    return store.get("analyses") || [];
  });
  import_electron5.ipcMain.handle("analyses:set", async (_event, analyses) => {
    const { default: Store } = await import("electron-store");
    const store = new Store();
    store.set("analyses", analyses);
    return true;
    return true;
  });
  import_electron5.ipcMain.handle("analyses:get-content", async (_event, id) => {
    try {
      const userDataPath = import_electron5.app.getPath("userData");
      const filePath = import_path4.default.join(userDataPath, "analysis_records", `${id}.json`);
      if (import_fs4.default.existsSync(filePath)) {
        const raw = import_fs4.default.readFileSync(filePath, "utf-8");
        return JSON.parse(raw);
      }
      return null;
    } catch (e) {
      console.error(`\u274C Failed to load analysis content for ${id}:`, e);
      return null;
    }
  });
  import_electron5.ipcMain.handle("settings:get-active-schedule", async () => {
    const { default: Store } = await import("electron-store");
    const store = new Store();
    return store.get("activeSchedule") || null;
  });
  import_electron5.ipcMain.handle("settings:get-wake-time", async () => {
    return SchedulerService.getInstance().getLastWakeTime();
  });
  import_electron5.ipcMain.handle("settings:set-secure", async (_event, { apiKey }) => {
    return SecureKeyManager.getInstance().setKey(apiKey);
  });
  import_electron5.ipcMain.handle("settings:check-key-status", async () => {
    return SecureKeyManager.getInstance().getKeyStatus();
  });
  import_electron5.ipcMain.handle("settings:get-secure", async () => {
    return SecureKeyManager.getInstance().getKey();
  });
  import_electron5.ipcMain.handle("auth:login", async (_event, bounds) => {
    if (!mainWindow) return false;
    return BrowserManager.getInstance().login(bounds, mainWindow);
  });
  import_electron5.ipcMain.handle("test-headless", async () => {
    try {
      console.log("\u{1F916} Starting BrowserManager (Persistent)...");
      const manager = BrowserManager.getInstance();
      const context = await manager.launch({ headless: false });
      const page = await context.newPage();
      console.log("\u{1F30D} Navigating to Instagram...");
      await page.goto("https://www.instagram.com/");
      try {
        await page.waitForSelector('svg[aria-label="Home"]', { timeout: 1e4 });
        console.log("\u2705 INSTAGRAM LOGIN CONFIRMED");
        return "Success: Logged in automatically (Persistent Profile)";
      } catch (e) {
        console.log("\u274C NOT LOGGED IN / SELECTOR TIMEOUT");
        return "Failed: Still on login page. Please log in manually to save territory.";
      }
    } catch (error) {
      console.error("CRITICAL PW ERROR:", error);
      return `Error: ${error.message}`;
    }
  });
  import_electron5.ipcMain.handle("clear-instagram-session", async () => {
    console.log("\u{1F9F9} Clearing Instagram Session only...");
    try {
      const userDataPath = import_electron5.app.getPath("userData");
      const sessionPath = import_path4.default.join(userDataPath, "session.json");
      if (import_fs4.default.existsSync(sessionPath)) {
        import_fs4.default.unlinkSync(sessionPath);
      }
      await import_electron5.session.fromPartition(SHARED_PARTITION).clearStorageData();
      await BrowserManager.getInstance().clearData();
      return true;
    } catch (e) {
      console.error("Clear Instagram Session Error:", e);
      return false;
    }
  });
}
import_electron5.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    import_electron5.app.quit();
  }
});
import_electron5.app.on("activate", () => {
  if (import_electron5.BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else {
    mainWindow?.show();
  }
});
//# sourceMappingURL=main.js.map
