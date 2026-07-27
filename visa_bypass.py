#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════════╗
║          US VISA SCHEDULING — COMPLETE BYPASS TOOL          ║
║                      v4.1 — Enhanced Stealth               ║
║                                                              ║
║  Engine: Playwright Chromium with comprehensive fingerprint ║
║   → Cloudflare Turnstile auto-detected + manual solve      ║
║   → Deep browser fingerprint hardening prevents re-challenge║
║   → Canvas/WebGL/AudioContext noise + Chrome runtime mock  ║
║                                                              ║
║  Reliability Fixes:                                          ║
║   → Auto browser crash recovery (relaunch + resume)         ║
║   → Auto session re-login (navigate + wait for auth)        ║
║   → Global network error retry (3x exponential backoff)     ║
║   → Global page timeout handler (force refresh + reopen)    ║
║   → Generic error page detection (500, 503, "went wrong")   ║
╚══════════════════════════════════════════════════════════════╝

SETUP:
  pip install -r requirements.txt
  playwright install chromium


USAGE:
  python visa_bypass.py

FIRST RUN:
  Browser opens → log in once → script saves session → monitors forever.
"""

import json
import os
import sys
import re
import time
import random
import threading
from datetime import datetime
from pathlib import Path

# ── optional sound (windows only) ──────────────────────────────
try:
    import winsound
    HAS_SOUND = True
except ImportError:
    HAS_SOUND = False

# ── requests (for Telegram) ─────────────────────────────────────
try:
    import requests as req_lib
except ImportError:
    req_lib = None

# ── Playwright ──────────────────────────────────────────────────
try:
    from playwright.sync_api import (
        sync_playwright, Page, Browser, BrowserContext,
        TimeoutError as PWTimeoutError, Error as PWError
    )
except ImportError:
    print("ERROR: pip install playwright && playwright install chromium")
    sys.exit(1)

# ── CloakBrowser disabled — always use standard Playwright Chromium ──
HAS_CLOAK = False  # Force Chrome/Chromium (manual challenge solve mode)
print("[INFO] Using standard Playwright Chromium (CloakBrowser disabled).")

# ── Playwright Stealth ──────────────────────────────────────────
try:
    from playwright_stealth import Stealth
    HAS_STEALTH = True
except ImportError:
    HAS_STEALTH = False
    print("[WARNING] playwright-stealth not installed — pip install playwright-stealth")

# ══════════════════════════════════════════════════════════════════
#  CONSTANTS
# ══════════════════════════════════════════════════════════════════
CONFIG_FILE   = "config.json"
LOG_FILE      = "visa_bypass.log"
PROFILE_DIR   = os.path.abspath("./chrome_profile_bypass")
OFC_URL       = "https://www.usvisascheduling.com/en-US/"
LOGIN_URL     = "https://www.usvisascheduling.com/Account/Login/ExternalAuthenticationFailed"
SITE_ROOT     = "https://www.usvisascheduling.com/"

LOCATIONS = {
    "CHE": "Chennai",
    "HYD": "Hyderabad",
    "KOL": "Kolkata",
    "MUM": "Mumbai",
    "DEL": "New Delhi",
}

# Generic error page strings (Fix 5)
GENERIC_ERROR_STRINGS = [
    "something went wrong",
    "500 internal server",
    "503 service unavailable",
    "an error has occurred",
    "we're sorry, but something",
    "application error",
    "unexpected error",
    "page not found",
    "404 not found",
]

# ── Comprehensive Stealth Fingerprint ──────────────────────────────
# Injected before ANY page JS runs — makes Cloudflare see a genuine browser.
# Covers: webdriver, plugins, mimeTypes, hardware, platform, languages,
# chrome runtime, canvas noise, WebGL spoofing, AudioContext noise,
# screen/geometry, permissions API, timezone, battery API, notifications.
ADVANCED_STEALTH_JS = r"""
(function() {
    'use strict';

    // ── 1. Remove ALL Selenium/CDP automation traces
    const CDP_VARS = [
        'cdc_adoQpoasnfa76pfcZLmcfl_Array',
        'cdc_adoQpoasnfa76pfcZLmcfl_Promise',
        'cdc_adoQpoasnfa76pfcZLmcfl_Symbol',
        '$chrome_asyncScriptInfo',
        '$cdc_asdjflasutopfhvcZLmcfl_',
        '__webdriver_evaluate',
        '__selenium_evaluate',
        '__webdriver_script_function',
        '__webdriver_script_func',
        '__webdriver_script_fn',
        '__fxdriver_evaluate',
        '__driver_unwrapped',
        '__webdriver_unwrapped',
        '__driver_evaluate',
        '__selenium_unwrapped',
        '__fxdriver_unwrapped',
        '__lastWatirAlert',
        '__lastWatirConfirm',
        '__lastWatirPrompt'
    ];
    CDP_VARS.forEach(v => { try { delete window[v]; } catch(e) {} });

    // ── 2. navigator.webdriver — restore as value property on Navigator.prototype
    // --disable-blink-features=AutomationControlled removes the property entirely,
    // but REAL Chrome has navigator.webdriver = false as a value property on
    // Navigator.prototype ({ value: false, writable: true, enumerable: true,
    // configurable: true }). Without it restored, "webdriver" in navigator
    // returns false — a detectable signal since real browsers always have it.
    // Crucially, we use value (not getter) on the prototype (not instance),
    // matching the exact property descriptor signature of real Chrome.
    try {
        Object.defineProperty(Navigator.prototype, 'webdriver', {
            value: false,
            writable: true,
            configurable: true,
            enumerable: true
        });
    } catch(e) {}

    // ── 3. Realistic Chrome plugins
    const makePlugin = (name, desc, filename, mimeTypes) => {
        const plugin = Object.create(Plugin.prototype);
        Object.defineProperties(plugin, {
            name:        { value: name,     enumerable: true },
            description: { value: desc,     enumerable: true },
            filename:    { value: filename, enumerable: true },
            length:      { value: mimeTypes.length, enumerable: true },
        });
        mimeTypes.forEach((mt, i) => {
            const mime = Object.create(MimeType.prototype);
            Object.defineProperty(mime, 'type', { value: mt.type, enumerable: true });
            Object.defineProperty(mime, 'suffixes', { value: mt.suffixes, enumerable: true });
            plugin[i] = mime;
        });
        return plugin;
    };

    const fakePlugins = [
        makePlugin('Chrome PDF Plugin', 'Portable Document Format',
            'internal-pdf-viewer',
            [{ type: 'application/x-google-chrome-pdf', suffixes: 'pdf' }]),
        makePlugin('Chrome PDF Viewer', '',
            'mhjfbmdgcfjbbpaeojofohoefgiehjai',
            [{ type: 'application/pdf', suffixes: 'pdf' }]),
        makePlugin('Native Client', '',
            'internal-nacl-plugin',
            [{ type: 'application/x-nacl', suffixes: '' },
             { type: 'application/x-pnacl', suffixes: '' }]),
    ];

    const pluginArray = Object.create(PluginArray.prototype);
    fakePlugins.forEach((p, i) => { pluginArray[i] = p; });
    Object.defineProperty(pluginArray, 'length', { value: fakePlugins.length });
    pluginArray.item = i => pluginArray[i];
    pluginArray.namedItem = name => fakePlugins.find(p => p.name === name) || null;
    pluginArray.refresh = () => {};
    Object.defineProperty(navigator, 'plugins', { get: () => pluginArray });

    // ── 4. MIME types
    const fakeMimes = [
        { type: 'application/pdf', suffixes: 'pdf', description: '' },
        { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' },
        { type: 'application/x-nacl', suffixes: '', description: 'Native Client Executable' },
        { type: 'application/x-pnacl', suffixes: '', description: 'Portable Native Client Executable' },
    ];
    const mimeArray = Object.create(MimeTypeArray.prototype);
    fakeMimes.forEach((m, i) => {
        const mime = Object.create(MimeType.prototype);
        Object.defineProperty(mime, 'type',        { value: m.type,        enumerable: true });
        Object.defineProperty(mime, 'suffixes',    { value: m.suffixes,    enumerable: true });
        Object.defineProperty(mime, 'description', { value: m.description, enumerable: true });
        mimeArray[i] = mime;
    });
    Object.defineProperty(mimeArray, 'length', { value: fakeMimes.length });
    Object.defineProperty(navigator, 'mimeTypes', { get: () => mimeArray });

    // ── 5. Hardware fingerprint
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory',        { get: () => 8 });
    Object.defineProperty(navigator, 'maxTouchPoints',      { get: () => 0 });
    Object.defineProperty(navigator, 'doNotTrack',          { get: () => null });

    // ── 6. Platform & browser identity
    Object.defineProperty(navigator, 'platform',    { get: () => 'Win32' });
    Object.defineProperty(navigator, 'vendor',      { get: () => 'Google Inc.' });
    Object.defineProperty(navigator, 'appVersion',  { get: () => '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.127 Safari/537.36' });
    Object.defineProperty(navigator, 'appName',     { get: () => 'Netscape' });
    Object.defineProperty(navigator, 'product',     { get: () => 'Gecko' });
    Object.defineProperty(navigator, 'productSub',  { get: () => '20030107' });
    Object.defineProperty(navigator, 'vendorSub',   { get: () => '' });
    Object.defineProperty(navigator, 'oscpu',       { get: () => undefined });

    // ── 6b. navigator.userAgentData (Chrome 90+) — CRITICAL for Cloudflare
    // This modern API reveals the REAL platform even if userAgent is spoofed.
    // The version numbers must EXACTLY match the userAgent string above.
    try {
        Object.defineProperty(navigator, 'userAgentData', {
            get: () => ({
                brands: [
                    { brand: 'Google Chrome', version: '126' },
                    { brand: 'Chromium', version: '126' },
                    { brand: 'Not.A/Brand', version: '99' },
                ],
                mobile: false,
                platform: 'Windows',
                getHighEntropyValues: function(hints) {
                    return Promise.resolve({
                        architecture: 'x86',
                        bitness: '64',
                        model: '',
                        platformVersion: '15.0.0',
                        uaFullVersion: '126.0.6478.127',
                        fullVersionList: [
                            { brand: 'Google Chrome', version: '126.0.6478.127' },
                            { brand: 'Chromium', version: '126.0.6478.127' },
                            { brand: 'Not.A/Brand', version: '99.0.0.0' },
                        ],
                        wow64: false,
                    });
                },
            }),
            configurable: true,
        });
    } catch(e) {}

    // ── 7. Languages
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'hi'] });
    Object.defineProperty(navigator, 'language',  { get: () => 'en-US' });

    // ── 8. Connection
    if (navigator.connection) {
        Object.defineProperty(navigator.connection, 'rtt', { get: () => 100 });
        Object.defineProperty(navigator.connection, 'downlink', { get: () => 10 });
    }

    // ── 9. Chrome runtime object (real Chrome has this)
    if (!window.chrome) {
        window.chrome = {
            app: { isInstalled: false },
            runtime: {
                OnMessageEvent: {},
                connect: () => {},
                sendMessage: () => {},
                id: undefined
            },
            loadTimes: function() {
                return {
                    requestTime: Date.now() / 1000 - Math.random() * 2,
                    startLoadTime: Date.now() / 1000 - Math.random() * 1.5,
                    commitLoadTime: Date.now() / 1000 - Math.random(),
                    finishDocumentLoadTime: Date.now() / 1000 - Math.random() * 0.5,
                    finishLoadTime: Date.now() / 1000,
                    firstPaintTime: Date.now() / 1000 - Math.random() * 0.3,
                    firstPaintAfterLoadTime: 0,
                    navigationType: 'Other',
                    wasFetchedViaSpdy: false,
                    wasNpnNegotiated: true,
                    npnNegotiatedProtocol: 'h2',
                    wasAlternateProtocolAvailable: false,
                    connectionInfo: 'h2'
                };
            },
            csi: function() {
                return { onloadT: Date.now(), startE: Date.now() - 200, pageT: Math.random() * 1000 + 500, tran: 15 };
            }
        };
    }

    // ── 10. Canvas fingerprint noise
    const _noise = (Math.random() * 10) | 0;
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(type, ...args) {
        const ctx = this.getContext('2d');
        if (ctx) {
            const imageData = ctx.getImageData(0, 0, this.width || 1, this.height || 1);
            for (let i = 0; i < imageData.data.length; i += 4096) {
                imageData.data[i] = (imageData.data[i] + _noise) % 256;
            }
            ctx.putImageData(imageData, 0, 0);
        }
        return origToDataURL.apply(this, [type, ...args]);
    };

    const origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
        const ctx = origGetContext.apply(this, [type, ...args]);
        if (ctx && type === '2d') {
            const origGetImageData = ctx.getImageData.bind(ctx);
            ctx.getImageData = function(x, y, w, h) {
                const data = origGetImageData(x, y, w, h);
                for (let i = 0; i < data.data.length; i += 3000) {
                    data.data[i] = (data.data[i] + (_noise & 0x03)) % 256;
                }
                return data;
            };
        }
        return ctx;
    };

    // ── 11. WebGL GPU identity spoofing
    const _getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(param) {
        if (param === 37445) return 'Google Inc. (NVIDIA)';
        if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
        if (param === 7936) return 'WebKit WebGL';
        if (param === 7937) return 'WebKit WebGL';
        if (param === 35724) return 'WebGL 1.0 (OpenGL ES 2.0 Chromium)';
        if (param === 35725) return 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)';
        if (param === 37447) return 8192;
        return _getParameter.apply(this, [param]);
    };
    try {
        const _getParameter2 = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = function(param) {
            if (param === 37445) return 'Google Inc. (NVIDIA)';
            if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
            if (param === 7936) return 'WebKit WebGL';
            if (param === 7937) return 'WebKit WebGL';
            if (param === 35724) return 'WebGL 2.0 (OpenGL ES 3.0 Chromium)';
            if (param === 35725) return 'WebGL GLSL ES 3.0 (OpenGL ES GLSL ES 3.0 Chromium)';
            if (param === 37447) return 16384;
            return _getParameter2.apply(this, [param]);
        };
    } catch(e) {}

    // ── 12. AudioContext fingerprint noise
    const origGetChannelData = AudioBuffer.prototype.getChannelData;
    AudioBuffer.prototype.getChannelData = function(channel) {
        const data = origGetChannelData.call(this, channel);
        for (let i = 0; i < data.length; i += 200) {
            data[i] += (_noise * 0.000001);
        }
        return data;
    };

    // ── 13. Screen geometry coherence
    Object.defineProperty(window.screen, 'width',       { get: () => 1366 });
    Object.defineProperty(window.screen, 'height',      { get: () => 768  });
    Object.defineProperty(window.screen, 'availWidth',  { get: () => 1366 });
    Object.defineProperty(window.screen, 'availHeight', { get: () => 728  });
    Object.defineProperty(window.screen, 'colorDepth',  { get: () => 24   });
    Object.defineProperty(window.screen, 'pixelDepth',  { get: () => 24   });

    // ── 14. Window dimensions (Chrome with tabs/bookmarks bar)
    try {
        Object.defineProperty(window, 'outerWidth',  { get: () => 1366 });
        Object.defineProperty(window, 'outerHeight', { get: () => 728  });
        Object.defineProperty(window, 'innerWidth',  { get: () => 1366 });
        Object.defineProperty(window, 'innerHeight', { get: () => 607  });
    } catch(e) {}

    // ── 15. Permissions API — full override
    if (navigator.permissions) {
        const origQuery = navigator.permissions.query.bind(navigator.permissions);
        navigator.permissions.query = function(params) {
            if (['notifications', 'camera', 'microphone', 'geolocation',
                 'midi', 'clipboard-read', 'clipboard-write',
                 'payment-handler', 'background-sync', 'ambient-light-sensor',
                 'accelerometer', 'gyroscope', 'magnetometer'].includes(params.name)) {
                return Promise.resolve({ state: 'prompt', onchange: null });
            }
            return origQuery(params);
        };
    }

    // ── 16. Timezone (India Standard Time — IST)
    Date.prototype.getTimezoneOffset = function() {
        return -330;   // IST = UTC+5:30
    };

    // ── 17. Mouse position tracker
    window.__mouse_x = 683;
    window.__mouse_y = 384;
    document.addEventListener('mousemove', e => {
        window.__mouse_x = e.clientX;
        window.__mouse_y = e.clientY;
    }, { passive: true, capture: true });

    // ── 18. Notification API stub
    if (typeof Notification !== 'undefined') {
        Object.defineProperty(Notification, 'permission', { get: () => 'default' });
    }

    // ── 19. Battery API stub (real Chrome exposes this)
    if (!navigator.getBattery) {
        navigator.getBattery = () => Promise.resolve({
            charging: true, chargingTime: 0,
            dischargingTime: Infinity, level: 0.97,
            addEventListener: () => {}, removeEventListener: () => {}
        });
    }

})();
"""

# ══════════════════════════════════════════════════════════════════
#  LOGGER
# ══════════════════════════════════════════════════════════════════
def ts():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def log(msg, level="INFO"):
    line = f"{ts()} [{level}] {msg}"
    print(line)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass

# ══════════════════════════════════════════════════════════════════
#  CONFIG MANAGER
# ══════════════════════════════════════════════════════════════════
class ConfigManager:

    DEFAULTS = {
        "locations":             ["CHE", "HYD", "KOL", "MUM", "DEL"],
        "facility_id":           "3f6bf614-b0db-ec11-a7b4-001dd80234f6",
        "polling_interval_min":  90,
        "polling_interval_max":  150,
        "pse_max_retries":       5,
        "calendar_timeout":      20,
        "rate_limit_pause":      180,
        "telegram_bot_token":    "",
        "telegram_chat_id":      "",
        "sound_alerts":          True,
        "headless":              False,
        "max_crash_restarts":    10,
        "proxy":                 "",
    }

    def __init__(self, path=CONFIG_FILE):
        self.path  = path
        self._data = {}
        self._mtime = 0
        self.load()

    def load(self):
        if not os.path.exists(self.path):
            log(f"config.json not found — creating defaults at {self.path}", "WARNING")
            self._data = dict(self.DEFAULTS)
            self.save()
            return
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                self._data = json.load(f)
            self._mtime = os.path.getmtime(self.path)
        except Exception as e:
            log(f"Config load error: {e}", "ERROR")
            self._data = dict(self.DEFAULTS)

    def save(self):
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(self._data, f, indent=4)

    def reload_if_changed(self):
        try:
            mtime = os.path.getmtime(self.path)
            if mtime > self._mtime:
                self.load()
                log("Config reloaded")
        except Exception:
            pass

    def get(self, key, default=None):
        return self._data.get(key, self.DEFAULTS.get(key, default))

    def show(self):
        print("\n" + "─" * 50)
        print("  CURRENT CONFIG")
        print("─" * 50)
        for k, v in self._data.items():
            if k == "telegram_bot_token" and v:
                print(f"  {k}: {v[:10]}...")
            else:
                print(f"  {k}: {v}")
        print("─" * 50 + "\n")


# ══════════════════════════════════════════════════════════════════
#  BROWSER MANAGER
# ══════════════════════════════════════════════════════════════════
class BrowserManager:

    def __init__(self, cfg: ConfigManager):
        self.cfg = cfg
        self._pw  = None   # sync_playwright instance
        self.browser: Browser | None = None
        self.context: BrowserContext | None = None
        self.page:    Page | None = None

    def launch(self) -> bool:
        """Launch browser with stealth fingerprint."""
        os.makedirs(PROFILE_DIR, exist_ok=True)
        headless = self.cfg.get("headless", False)
        proxy_url = self.cfg.get("proxy", "").strip()

        # Detect if running as root (common on Kali Linux)
        is_root = (os.getuid() == 0) if hasattr(os, "getuid") else False
        if is_root:
            log("Running as root — configuring Chrome for root environment", "WARNING")

        # CRITICAL: Use standard Chrome flags only.
        # --disable-blink-features=AutomationControlled prevents Blink from setting
        # navigator.webdriver=true. This is a standard Chrome flag also added by
        # Playwright itself — we're just being explicit.
        # --no-sandbox is required for Linux VMs/containers.
        pw_args = [
            "--no-sandbox",
            "--window-size=1366,768",
            "--disable-blink-features=AutomationControlled",
            "--disable-dev-shm-usage",
        ]
        if is_root:
            pw_args.append("--disable-setuid-sandbox")

        for attempt in range(1, 4):
            try:
                if HAS_CLOAK:
                    log(f"Launching CloakBrowser persistent context (attempt {attempt})...")
                    cloak_kwargs = {
                        "user_data_dir": PROFILE_DIR,
                        "headless":      False,
                        "humanize":      True,
                        "stealth_args":  True,
                        "geoip":         True,
                        "args":          extra_args,
                    }
                    if proxy_url:
                        cloak_kwargs["proxy"] = proxy_url
                        log(f"Using proxy: {proxy_url[:30]}...")
                    else:
                        log("⚠️  No proxy configured — Cloudflare may block datacenter IPs", "WARNING")
                        log("   Set 'proxy' in config.json: 'http://user:pass@host:port'", "WARNING")
                        cloak_kwargs["geoip"] = False
                        cloak_kwargs["locale"] = "en-US"

                    self.context = cloak_launch_persistent(**cloak_kwargs)
                    self.page = self.context.new_page()

                else:
                    log(f"Using Playwright Chromium (attempt {attempt})...")
                    if self._pw is None:
                        self._pw = sync_playwright().start()

                    try:
                        self.context = self._pw.chromium.launch_persistent_context(
                            user_data_dir=PROFILE_DIR,
                            headless=headless,
                            args=pw_args,
                            viewport={"width": 1366, "height": 768},
                            user_agent=(
                                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                                "AppleWebKit/537.36 (KHTML, like Gecko) "
                                "Chrome/126.0.6478.127 Safari/537.36"
                            ),
                            ignore_default_args=["--enable-automation"],
                        )
                        self.page = self.context.new_page()

                    except Exception as pctx_err:
                        log(f"Persistent context failed ({pctx_err}) — plain launch fallback", "WARNING")
                        if self.context:
                            try:
                                self.context.close()
                            except Exception:
                                pass
                            self.context = None

                        self.browser = self._pw.chromium.launch(
                            headless=headless,
                            args=pw_args,
                        )
                        self.context = self.browser.new_context(
                            viewport={"width": 1366, "height": 768},
                            user_agent=(
                                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                                "AppleWebKit/537.36 (KHTML, like Gecko) "
                                "Chrome/126.0.6478.127 Safari/537.36"
                            ),
                        )
                        self.page = self.context.new_page()
                        log("Plain browser launch OK (session NOT saved to profile)", "WARNING")

                # Set timeouts
                self.page.set_default_timeout(30_000)
                self.page.set_default_navigation_timeout(35_000)

                # ── playwright-stealth complementary evasions (belt) ────
                # Adds 4 evasions our custom script intentionally leaves out:
                #   • iframe.contentWindow – proxy-based iframe contentWindow fix
                #   • error.prototype     – Error.prototype.name hardening
                #   • media.codecs        – Missing video/audio codec support
                #   • hairline            – Modernizr offsetHeight fix
                # Runs BEFORE our custom script, so our values take precedence
                # on any overlapping properties.
                if HAS_STEALTH:
                    try:
                        _ps = Stealth(
                            chrome_app=False, chrome_csi=False,
                            chrome_load_times=False, chrome_runtime=False,
                            hairline=True,              # Modernizr offsetHeight fix
                            iframe_content_window=True,  # iframe.contentWindow proxy
                            media_codecs=True,           # Missing video/audio codecs
                            navigator_hardware_concurrency=False,
                            navigator_languages=False,
                            navigator_permissions=False,
                            navigator_platform=False,
                            navigator_plugins=False,     # Handled by custom ADVANCED_STEALTH_JS (runs second)
                            navigator_user_agent=False,
                            navigator_user_agent_data=False,
                            navigator_vendor=False,
                            navigator_webdriver=False,    # We handle via CLI args
                            error_prototype=True,         # Error.prototype.name fix
                            webgl_vendor=False,
                            sec_ch_ua=False,              # We handle UA via launch args
                            init_scripts_only=True,       # Don't patch our launch args
                        )
                        if self.context:
                            _ps.apply_stealth_sync(self.context)
                        if self.page:
                            _ps.apply_stealth_sync(self.page)
                        log("playwright-stealth complementary evasions applied ✅")
                    except Exception as _ps_err:
                        log(f"playwright-stealth injection note: {_ps_err}", "WARNING")

                # Inject comprehensive stealth fingerprint at BOTH context + page level.
                # Context-level add_init_script runs on all future new documents.
                # Page-level add_init_script explicitly targets this page's sub-frames.
                # This ensures Turnstile iframes also get the stealth modifications.
                try:
                    if self.context:
                        self.context.add_init_script(ADVANCED_STEALTH_JS)
                    if self.page:
                        self.page.add_init_script(ADVANCED_STEALTH_JS)
                    log("Comprehensive stealth fingerprint injected (context + page) ✅")
                except Exception as stealth_err:
                    log(f"Stealth injection warning: {stealth_err}", "WARNING")

                log("Browser launched ✅")
                return True

            except Exception as e:
                log(f"Browser launch attempt {attempt} failed: {e}", "WARNING")
                self._safe_quit()
                time.sleep(4)

        log("All browser launch attempts failed", "ERROR")
        return False

    def alive(self) -> bool:
        try:
            if self.page is None:
                return False
            _ = self.page.url
            return True
        except Exception:
            return False

    def _safe_quit(self):
        for obj in (self.page, self.context, self.browser):
            try:
                if obj:
                    obj.close()
            except Exception:
                pass
        self.page = self.context = self.browser = None

    def quit(self):
        self._safe_quit()
        try:
            if self._pw:
                self._pw.stop()
        except Exception:
            pass


# ══════════════════════════════════════════════════════════════════
#  SAFE NAV
# ══════════════════════════════════════════════════════════════════
def safe_goto(page: Page, url: str, max_attempts: int = 3) -> bool:
    for attempt in range(1, max_attempts + 1):
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=35_000)
            return True
        except PWTimeoutError:
            log(f"Navigation timeout ({attempt}/{max_attempts}): {url[:60]}", "WARNING")
            try:
                page.reload(wait_until="domcontentloaded", timeout=20_000)
                return True
            except Exception:
                pass
        except PWError as e:
            log(f"Navigation error ({attempt}/{max_attempts}): {e}", "WARNING")
        except Exception as e:
            log(f"Unexpected nav error ({attempt}/{max_attempts}): {e}", "WARNING")

        wait = min(5 * attempt, 20)
        log(f"Waiting {wait}s before retry...")
        time.sleep(wait)

    return False


def safe_content(page: Page) -> str:
    try:
        return page.content()
    except Exception:
        return ""


def safe_url(page: Page) -> str:
    try:
        return page.url
    except Exception:
        return ""


# ══════════════════════════════════════════════════════════════════
#  ERROR DETECTOR
# ══════════════════════════════════════════════════════════════════
class ErrorDetector:

    def detect(self, page: Page) -> list[str]:
        errors = []
        try:
            content = safe_content(page).lower()
            url     = safe_url(page).lower()

            # PSE0501
            if "pse0501" in content or "unable to load appointment available days" in content:
                errors.append("PSE0501_PAGE")

            # Cloudflare "Just a moment" / "Verify you are human" JS challenge
            if (("just a moment" in content or "checking your browser" in content or
                 "verify you are human" in content or "verifying you are human" in content)
                    and ("cloudflare" in content or "cf-browser-verification" in content)):
                errors.append("CF_JS_CHALLENGE")

            # ── Cloudflare Turnstile detection (aggressive multi-layer) ──
            cf_detected = False

            # Layer 1: Check ALL frames (including iframes) for Cloudflare challenge URLs
            try:
                for frame in page.frames:
                    fu = (frame.url or "").lower()

                    # Direct Cloudflare challenge iframe URL match
                    if ("challenges.cloudflare.com" in fu or
                            "cloudflare.com/cdn-cgi/challenge" in fu or
                            "/cdn-cgi/challenge" in fu or
                            "turnstile" in fu):
                        cf_detected = True
                        break

                    # Scan iframe CONTENT (not just URL) — critical for re-challenge detection
                    # because Cloudflare can inject challenge content dynamically
                    try:
                        fc = (frame.content() or "").lower()
                        if ("turnstile" in fc or "cf-turnstile" in fc or
                                "cfturnstile" in fc or "i am not a robot" in fc or
                                "i verify" in fc or "i am human" in fc or
                                "cf-challenge" in fc or "cf_challenge" in fc or
                                "challenges.cloudflare" in fc or
                                "just a moment" in fc):
                            cf_detected = True
                            break
                    except Exception:
                        pass
            except Exception:
                pass

            # Layer 2: JS evaluation for inline Turnstile widgets
            if not cf_detected:
                try:
                    has_widget = page.evaluate("""
                        (function() {
                            // Check for Turnstile API
                            if (typeof window.turnstile !== 'undefined') return true;
                            // Check for DOM elements
                            if (!!document.querySelector('cf-turnstile, [data-sitekey], #cf-stage')) return true;
                            if (!!document.querySelector('input[name="cf-turnstile-response"]')) return true;
                            // Check for Turnstile script tags
                            var scripts = document.querySelectorAll('script[src*="turnstile"], script[src*="challenges.cloudflare"]');
                            if (scripts.length > 0) return true;
                            // Check for challenge overlay / stage
                            if (!!document.getElementById('cf-challenge-stage')) return true;
                            return false;
                        })()
                    """)
                    if has_widget:
                        cf_detected = True
                except Exception:
                    pass

            # Layer 3: HTML content pattern matching
            if not cf_detected and (
                    "cf-turnstile" in content or "cfturnstile" in content or
                    "challenges.cloudflare" in content or
                    "i am not a robot" in content or
                    "i verify" in content or "i am human" in content or
                    ("enable javascript" in content and "cloudflare" in content) or
                    "cf-challenge" in content or "cf_challenge" in content):
                cf_detected = True

            if cf_detected:
                errors.append("CF_TURNSTILE")

            # Cloudflare waiting room
            if "waiting room" in content or "you are now in line" in content:
                errors.append("WAITING_ROOM")

            # Rate limit 1015
            if "error 1015" in content or "you are being rate limited" in content:
                errors.append("ERROR_1015")

            # Server outage
            if ("scheduling portal is currently experiencing technical issues" in content or
                    "we apologise for this inconvenience as we work to resolve" in content):
                errors.append("SERVER_OUTAGE")

            # Access blocked (Cloudflare 1020)
            if ("sorry, you have been blocked" in content and
                    ("cloudflare" in content or "ray id" in content or "1020" in content)):
                errors.append("BLOCKED")

            # Session expired
            if ("sign in" in content or "please log in" in content or "log in to continue" in content):
                if "ofc-schedule" not in url and "usvisascheduling" in url:
                    errors.append("SESSION_EXPIRED")

            # Generic error pages
            for err_str in GENERIC_ERROR_STRINGS:
                if err_str in content:
                    errors.append("GENERIC_ERROR")
                    break

            # Stuck loading
            if "loading..." in safe_content(page) and ("ofc-schedule" in url or "usvisascheduling" in url):
                errors.append("LOADING_STUCK")

        except Exception as e:
            log(f"ErrorDetector exception: {e}", "WARNING")
            errors.append("BROWSER_ERROR")

        return list(dict.fromkeys(errors))

    def has_challenge(self, page: Page) -> bool:
        e = self.detect(page)
        return "CF_TURNSTILE" in e or "CF_JS_CHALLENGE" in e

    def is_clean(self, page: Page) -> bool:
        return len(self.detect(page)) == 0


# ══════════════════════════════════════════════════════════════════
#  CHALLENGE HANDLER
# ══════════════════════════════════════════════════════════════════
class ChallengeHandler:

    def __init__(self, cfg: ConfigManager, detector: ErrorDetector):
        self.cfg      = cfg
        self.detector = detector

    # ── JS alert helper ───────────────────────────────────────────
    def _dismiss_alert(self, page: Page):
        try:
            page.on("dialog", lambda d: d.accept())
        except Exception:
            pass

    # ── Dismiss Bootstrap/custom modal ────────────────────────────
    def _dismiss_modal(self, page: Page):
        selectors = [
            "button:has-text('OK')",
            "button:has-text('Close')",
            ".modal .btn",
            "[data-dismiss='modal']",
            ".modal-footer button",
            "button[data-bs-dismiss='modal']",
        ]
        for sel in selectors:
            try:
                el = page.query_selector(sel)
                if el and el.is_visible():
                    el.click()
                    time.sleep(0.4)
                    return
            except Exception:
                continue
        try:
            page.evaluate("""
                document.querySelectorAll('.modal.show, .modal[style*="display: block"]')
                    .forEach(m => { m.classList.remove('show'); m.style.display='none'; });
                var bd = document.querySelector('.modal-backdrop');
                if (bd) bd.remove();
                document.body.classList.remove('modal-open');
                document.body.style.overflow = '';
                document.body.style.paddingRight = '';
            """)
        except Exception:
            pass

    # ── PSE0501 bypass ─────────────────────────────────────────────
    def bypass_pse0501(self, page: Page, attempt: int = 1):
        log(f"PSE0501 bypass (attempt {attempt})", "WARNING")
        self._dismiss_modal(page)
        wait = min(5 * (2 ** (attempt - 1)), 60) + random.uniform(0, 3)
        log(f"Waiting {wait:.1f}s before retry...")
        time.sleep(wait)

    # ── Cloudflare challenge — MANUAL SOLVE + NAV REINFORCE + RE-CHALLENGE SHIELD ──
    def _handle_cf_challenge(self, page: Page):
        """
        Cloudflare Turnstile / JS challenge handler with re-challenge prevention.

        Flow:
          1. Wait for manual solve (user clicks "Verify you are human")
          2. After clear → force navigate to current URL (applies cf_clearance cookie)
          3. 15-second "re-challenge shield" — monitors for instant re-challenge
          4. If re-challenge caught → loop back to step 1 automatically
          5. Return only after sustained clearance verified
        """
        log("Cloudflare challenge detected — waiting for manual solve", "WARNING")
        _beep("warning")

        print("\n" + "═" * 60)
        print("  🛡️  CLOUDFLARE CHALLENGE — MANUAL SOLVE")
        print("  ────────────────────────────────────────────")
        print('  Check the browser window and click:')
        print('  ✅  "Verify you are human" / "I am not a robot"')
        print("  ")
        print("  After you solve, script will automatically:")
        print("  → Re-navigate to apply the clearance cookie")
        print("  → Monitor 15s for re-challenge (auto-handled)")
        print("  → Resume monitoring once fully cleared")
        print("═" * 60)

        # ── Main solve loop (with re-challenge recovery) ────────────
        for solve_attempt in range(5):  # max 5 re-challenge recovery attempts
            # ── Wait for manual solve ────────────────────────────────
            cleared = False
            elapsed_total = 0
            for tick in range(150):  # 150 × 4s = 10 min per attempt
                time.sleep(4)
                elapsed_total = (tick + 1) * 4
                try:
                    if not self.detector.has_challenge(page):
                        cleared = True
                        break
                except Exception:
                    pass

                if tick % 5 == 0:
                    log(f"  Waiting for manual solve... ({elapsed_total}s elapsed)")
                    if tick > 0 and tick % 15 == 0:
                        _beep("warning")

            if not cleared:
                log(f"Challenge wait timed out after 10 min — resuming anyway", "WARNING")
                return

            # ── Step 1: Force navigate to OFC page (applies cf_clearance cookie) ──
            log(f"Challenge cleared ✅ (solved in {elapsed_total}s) — navigating to OFC page to apply cookie...")
            print(f"  ✅ Challenge cleared in {elapsed_total}s! Applying clearance cookie...")

            # Navigate to OFC_URL (predictable target) rather than current URL
            # because Cloudflare sometimes redirects to a challenge interstitial.
            # Navigating to OFC_URL forces Cloudflare to validate the new cookie.
            safe_goto(page, OFC_URL)
            time.sleep(2)

            # Re-inject stealth script on the freshly loaded page (belt AND suspenders)
            try:
                page.add_init_script(ADVANCED_STEALTH_JS)
                log("Stealth script re-injected after navigation ✅")
            except Exception as reinject_err:
                log(f"Stealth re-injection note: {reinject_err}", "WARNING")

            # ── Step 2: Re-challenge shield (15s monitoring) ─────────
            log("🛡️  Re-challenge shield active — monitoring 15s...")
            print("  🛡️  Re-challenge shield active — monitoring 15s...")

            rechallenged = False
            for shield_tick in range(15):  # 15 × 1s = 15s
                time.sleep(1)
                try:
                    if self.detector.has_challenge(page):
                        log(f"🔄 Re-challenge detected at +{shield_tick+1}s — handling...", "WARNING")
                        print(f"  🔄 Re-challenge detected! Handling automatically...")
                        rechallenged = True
                        break
                except Exception:
                    pass

            if rechallenged:
                # Re-inject stealth script before retrying
                try:
                    page.add_init_script(ADVANCED_STEALTH_JS)
                except Exception:
                    pass
                log(f"Re-challenge shield triggered — going back to wait mode (attempt {solve_attempt+1}/5)")
                _beep("warning")
                time.sleep(1)
                continue

            # ── Success: no re-challenge detected ────────────────────
            log(f"Re-challenge shield passed ✅ — no re-challenge detected")
            print(f"  ✅ Challenge fully cleared! Resuming monitoring...")
            return

        # ── Max re-challenge recovery attempts reached ───────────────
        log(f"Re-challenge persists after {5} recovery attempts — continuing anyway", "WARNING")
        print(f"  ⚠️  Re-challenge persists. Continuing anyway...")

    # ── Waiting room ──────────────────────────────────────────────
    def bypass_waiting_room(self, page: Page):
        log("In Cloudflare waiting room — polling...", "WARNING")
        print("\n  ⏳ In Cloudflare queue. Auto-monitoring...")
        elapsed = 0
        while True:
            time.sleep(10)
            elapsed += 10
            try:
                content = safe_content(page).lower()
                if "waiting room" not in content and "you are now in line" not in content:
                    log(f"Passed waiting room after {elapsed}s ✅")
                    return
                if elapsed % 60 == 0:
                    log(f"Still in queue ({elapsed}s elapsed)...")
            except Exception:
                return

    # ── Rate limit 1015 ───────────────────────────────────────────
    def bypass_rate_limit(self, page: Page):
        pause = self.cfg.get("rate_limit_pause", 180)
        log(f"Rate limited (1015) — cooldown {pause}s", "WARNING")
        print(f"\n  ⚠️  Rate limited — resuming in {pause}s...")
        for remaining in range(pause, 0, -15):
            log(f"Rate limit cooldown: {remaining}s left")
            time.sleep(15)
        safe_goto(page, OFC_URL)
        time.sleep(5)

    # ── Server outage ─────────────────────────────────────────────
    def bypass_outage(self, page: Page):
        log("Server outage — monitoring for recovery", "WARNING")
        print("\n  ⚠️  Server outage. Auto-monitoring for recovery...")
        for _ in range(30):   # up to 5 minutes
            time.sleep(10)
            try:
                if "experiencing technical issues" not in safe_content(page).lower():
                    log("Server recovered ✅")
                    return
            except Exception:
                return

    # ── Access blocked ────────────────────────────────────────────
    def bypass_blocked(self, page: Page):
        log("Access blocked — waiting 2 minutes", "WARNING")
        time.sleep(120)
        safe_goto(page, OFC_URL)
        time.sleep(6)

    # ── Session expired ───────────────────────────────────────────
    def bypass_session_expired(self, page: Page):
        log("Session expired — auto-navigating to login page", "WARNING")
        _beep("error")

        print("\n" + "═" * 60)
        print("  🔴 SESSION EXPIRED — Logging you back in...")
        print("  The browser is navigating to the login page now.")
        print("  Please log in. Script resumes automatically after.")
        print("═" * 60)

        try:
            safe_goto(page, LOGIN_URL)
            time.sleep(3)
        except Exception:
            safe_goto(page, SITE_ROOT)

        self._wait_for_ofc_page(page)
        log("Session restored ✅")

    def _wait_for_ofc_page(self, page: Page):
        while True:
            try:
                url     = safe_url(page).lower()
                content = safe_content(page)
                if ("ofc-schedule" in url or
                        "OFC Post" in content or
                        "Applicant Schedule OFC" in content or
                        any(loc in content for loc in LOCATIONS)):
                    return
            except Exception:
                pass
            time.sleep(4)

    # ── Generic error page ────────────────────────────────────────
    def bypass_generic_error(self, page: Page):
        log("Generic error page detected — refreshing", "WARNING")
        for attempt in range(3):
            try:
                page.reload(wait_until="domcontentloaded", timeout=20_000)
                time.sleep(3)
                content = safe_content(page).lower()
                if not any(s in content for s in GENERIC_ERROR_STRINGS):
                    return
            except Exception:
                pass
            time.sleep(5 * (attempt + 1))

        safe_goto(page, OFC_URL)
        time.sleep(5)

    # ── Stuck loading ─────────────────────────────────────────────
    def bypass_loading_stuck(self, page: Page):
        log("Stuck loading — force refreshing", "WARNING")
        try:
            page.reload(wait_until="domcontentloaded", timeout=20_000)
            time.sleep(5)
        except Exception:
            safe_goto(page, OFC_URL)
            time.sleep(5)

    # ── Master dispatcher ─────────────────────────────────────────
    def handle_all(self, page: Page, pse_attempt: int = 1) -> bool:
        for _ in range(15):
            try:
                errors = self.detector.detect(page)
            except Exception:
                errors = ["BROWSER_ERROR"]

            if not errors:
                return True

            log(f"Handling errors: {errors}", "WARNING")

            if "BROWSER_ERROR" in errors:
                return False

            if "WAITING_ROOM" in errors:
                self.bypass_waiting_room(page)
                continue

            if "CF_JS_CHALLENGE" in errors or "CF_TURNSTILE" in errors:
                self._handle_cf_challenge(page)
                continue

            if "ERROR_1015" in errors:
                self.bypass_rate_limit(page)
                continue

            if "SERVER_OUTAGE" in errors:
                self.bypass_outage(page)
                continue

            if "BLOCKED" in errors:
                self.bypass_blocked(page)
                continue

            if "SESSION_EXPIRED" in errors:
                self.bypass_session_expired(page)
                continue

            if "PSE0501_PAGE" in errors:
                self.bypass_pse0501(page, pse_attempt)
                pse_attempt += 1
                continue

            if "GENERIC_ERROR" in errors:
                self.bypass_generic_error(page)
                continue

            if "LOADING_STUCK" in errors:
                self.bypass_loading_stuck(page)
                continue

            log(f"Unknown errors: {errors} — waiting 10s", "WARNING")
            time.sleep(10)

        return True


# ══════════════════════════════════════════════════════════════════
#  SESSION KEEP-ALIVE
# ══════════════════════════════════════════════════════════════════
class KeepAlive:

    def __init__(self, page: Page):
        self.page   = page
        self._stop  = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True)

    def start(self):
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _loop(self):
        tick = 0
        while not self._stop.is_set():
            time.sleep(30)
            tick += 1
            try:
                url = safe_url(self.page).lower()
                if "ofc-schedule" not in url:
                    continue

                self.page.mouse.move(
                    random.randint(200, 1000),
                    random.randint(150, 600)
                )

                if tick % 6 == 0:
                    self.page.evaluate(
                        "window.scrollBy(0, 12); "
                        "setTimeout(() => window.scrollBy(0, -12), 600);"
                    )
            except Exception:
                pass


# ══════════════════════════════════════════════════════════════════
#  CALENDAR READER
# ══════════════════════════════════════════════════════════════════
class CalendarReader:

    DATE_SELECTORS = [
        "td[data-date]:not(.disabled):not(.past)",
        "td.available:not(.disabled)",
        "td.open",
        "td.day:not(.disabled):not(.old)",
    ]

    def __init__(self, cfg: ConfigManager, handler: ChallengeHandler, detector: ErrorDetector):
        self.cfg      = cfg
        self.handler  = handler
        self.detector = detector

    def _click_location(self, page: Page, loc_code: str) -> bool:
        try:
            btns = page.query_selector_all("button")
            for btn in btns:
                try:
                    if btn.text_content().strip().upper() == loc_code and btn.is_visible() and btn.is_enabled():
                        btn.scroll_into_view_if_needed()
                        time.sleep(random.uniform(0.3, 0.8))
                        btn.click()
                        return True
                except Exception:
                    continue
        except Exception as e:
            log(f"click_location error: {e}", "WARNING")
        return False

    def _wait_for_calendar(self, page: Page) -> str:
        timeout = self.cfg.get("calendar_timeout", 20)
        for i in range(timeout):
            time.sleep(1)
            try:
                errors = self.detector.detect(page)

                if "PSE0501_PAGE" in errors:
                    return "pse0501"
                if "CF_TURNSTILE" in errors or "CF_JS_CHALLENGE" in errors:
                    return "cf_challenge"
                if "ERROR_1015" in errors:
                    return "rate_limit"
                if "SERVER_OUTAGE" in errors:
                    return "outage"
                if "GENERIC_ERROR" in errors:
                    return "generic_error"

                for sel in self.DATE_SELECTORS:
                    els = page.query_selector_all(sel)
                    if els:
                        return "ready"

                content = safe_content(page)
                if "loading..." not in content.lower()[:3000]:
                    return "ready"

            except Exception:
                pass

        return "timeout"

    def _read_dates(self, page: Page, loc_code: str) -> list[str]:
        dates = []
        for sel in self.DATE_SELECTORS:
            try:
                els = page.query_selector_all(sel)
                for el in els:
                    try:
                        val = (el.get_attribute("data-date") or
                               el.get_attribute("title") or
                               el.text_content().strip())
                        if val and val not in dates:
                            dates.append(val)
                    except Exception:
                        continue
                if dates:
                    break
            except Exception:
                continue

        if not dates:
            try:
                cal = page.query_selector(
                    "[class*='calendar'], [class*='datepicker'], [id*='calendar']"
                )
                if cal:
                    nums = re.findall(r'\b([1-9]|[12]\d|3[01])\b', cal.text_content())
                    dates = list(dict.fromkeys(nums))
            except Exception:
                pass

        return dates

    def check_location(self, page: Page, loc_code: str) -> list[str]:
        loc_name    = LOCATIONS.get(loc_code, loc_code)
        max_retries = self.cfg.get("pse_max_retries", 5)

        for attempt in range(1, max_retries + 1):
            log(f"  [{loc_code}] {loc_name} — attempt {attempt}/{max_retries}")

            self.handler.handle_all(page, pse_attempt=attempt)

            clicked = self._click_location(page, loc_code)
            if not clicked:
                log(f"  [{loc_code}] Location button not found", "WARNING")
                try:
                    if "ofc-schedule" not in safe_url(page).lower():
                        safe_goto(page, OFC_URL)
                        time.sleep(5)
                        self.handler.handle_all(page)
                        clicked = self._click_location(page, loc_code)
                        if not clicked:
                            return []
                except Exception:
                    return []

            result = self._wait_for_calendar(page)

            if result == "ready":
                dates = self._read_dates(page, loc_code)
                if dates:
                    log(f"  [{loc_code}] ✅ {len(dates)} date(s): {dates[:6]}")
                else:
                    log(f"  [{loc_code}] No dates available")
                return dates

            elif result in ("pse0501", "cf_challenge"):
                if result == "cf_challenge":
                    log(f"  [{loc_code}] Cloudflare — auto-handling...", "WARNING")
                    self.handler._handle_cf_challenge(page)
                else:
                    log(f"  [{loc_code}] PSE0501 on attempt {attempt}", "WARNING")
                    self.handler.bypass_pse0501(page, attempt)
                if attempt >= max_retries:
                    log(f"  [{loc_code}] Max retries reached — skipping")
                    return []
                continue

            elif result == "rate_limit":
                self.handler.bypass_rate_limit(page)
                continue

            elif result == "outage":
                self.handler.bypass_outage(page)
                continue

            elif result == "generic_error":
                self.handler.bypass_generic_error(page)
                continue

            elif result == "timeout":
                log(f"  [{loc_code}] Timeout — reading whatever is available")
                return self._read_dates(page, loc_code)

        return []


# ══════════════════════════════════════════════════════════════════
#  NOTIFIER
# ══════════════════════════════════════════════════════════════════
class Notifier:

    def __init__(self, cfg: ConfigManager):
        self.cfg = cfg

    def alert_found(self, results: dict):
        _beep("success")
        self._print_banner(results)
        self._telegram(results)

    def _print_banner(self, results: dict):
        print("\n")
        print("█" * 58)
        print("█                                                        █")
        print("█   🎉  VISA APPOINTMENT SLOTS FOUND!  🎉               █")
        print("█                                                        █")
        for loc, dates in results.items():
            if dates:
                name = LOCATIONS.get(loc, loc)
                line = f"  {loc} ({name}): {len(dates)} slot(s) → {dates[:5]}"
                print(f"█  {line:<54} █")
        print("█                                                        █")
        print("█   BOOK NOW BEFORE THEY DISAPPEAR!                     █")
        print("█                                                        █")
        print("█" * 58)
        print()

    def _telegram(self, results: dict):
        if req_lib is None:
            return
        token   = self.cfg.get("telegram_bot_token", "")
        chat_id = self.cfg.get("telegram_chat_id", "")
        if not token or not chat_id:
            return

        lines = ["🎉 *US VISA SLOTS FOUND!*\n"]
        for loc, dates in results.items():
            if dates:
                name = LOCATIONS.get(loc, loc)
                lines.append(f"✅ *{loc} ({name})*: {', '.join(str(d) for d in dates[:5])}")
        lines.append("\n⚡ Book NOW at https://www.usvisascheduling.com")
        msg = "\n".join(lines)

        try:
            req_lib.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json={"chat_id": chat_id, "text": msg, "parse_mode": "Markdown"},
                timeout=10,
            )
            log("Telegram alert sent ✅")
        except Exception as e:
            log(f"Telegram alert failed: {e}", "WARNING")


# ══════════════════════════════════════════════════════════════════
#  HELPERS
# ══════════════════════════════════════════════════════════════════
def _beep(kind: str = "success"):
    if not HAS_SOUND:
        return
    try:
        if kind == "success":
            for freq, dur in [(800, 150), (1000, 150), (1200, 150), (1500, 400)]:
                winsound.Beep(freq, dur)
        elif kind == "warning":
            for _ in range(3):
                winsound.Beep(600, 300)
                time.sleep(0.1)
        elif kind == "error":
            for _ in range(5):
                winsound.Beep(400, 500)
                time.sleep(0.1)
    except Exception:
        pass


def _page_alive(page: Page) -> bool:
    try:
        _ = page.url
        return True
    except Exception:
        return False


def _get_loc_buttons(page: Page) -> list[str]:
    found = []
    try:
        btns = page.query_selector_all("button")
        for btn in btns:
            try:
                txt = btn.text_content().strip().upper()
                if txt in LOCATIONS and btn.is_visible():
                    found.append(txt)
            except Exception:
                continue
    except Exception:
        pass
    return found


# ══════════════════════════════════════════════════════════════════
#  WAIT FOR LOGIN
# ══════════════════════════════════════════════════════════════════
def wait_for_login(page: Page, handler: ChallengeHandler):
    log("Opening site...")
    safe_goto(page, OFC_URL)

    print("\n" + "═" * 60)
    print("  📋  MANUAL STEPS REQUIRED")
    print("  ──────────────────────────────────────────────────")
    print("  Step 1: Solve the Cloudflare challenge in the browser")
    print('          Click "Verify you are human" checkbox')
    print("  Step 2: Log in with your visa account credentials")
    print("  Step 3: Navigate to the OFC Schedule page")
    print("          (page with CHE / HYD / KOL / MUM / DEL buttons)")
    print("  ")
    print("  ⚡ Script takes over automatically after Step 3")
    print("═" * 60 + "\n")

    detector = ErrorDetector()
    check_count = 0
    while True:
        try:
            check_count += 1
            errs = detector.detect(page)

            if "CF_TURNSTILE" in errs or "CF_JS_CHALLENGE" in errs:
                handler._handle_cf_challenge(page)
                continue

            if "WAITING_ROOM" in errs:
                handler.bypass_waiting_room(page)
                continue

            if "ERROR_1015" in errs:
                handler.bypass_rate_limit(page)
                continue

            if "BLOCKED" in errs:
                log("Access blocked by Cloudflare — waiting 2 min before retry", "WARNING")
                print("  ⚠️  Blocked by Cloudflare. Waiting 2 min then refreshing...")
                time.sleep(120)
                safe_goto(page, OFC_URL)
                time.sleep(5)
                continue

            content = safe_content(page)
            url     = safe_url(page).lower()

            if ("ofc-schedule" in url or
                    "OFC Post" in content or
                    "Applicant Schedule OFC" in content or
                    any(loc in content for loc in LOCATIONS)):
                log(f"✅ OFC page ready: {url[:60]}")
                print("  ✅ OFC page detected! Starting monitoring...")
                time.sleep(2)
                return

            if check_count % 3 == 0:
                log(f"Waiting for OFC page... ({url[:50]})")
            time.sleep(4)

        except Exception as e:
            log(f"Login wait error: {e}", "WARNING")
            time.sleep(5)


# ══════════════════════════════════════════════════════════════════
#  MAIN MONITOR LOOP
# ══════════════════════════════════════════════════════════════════
def run_monitor(bm: BrowserManager, cfg: ConfigManager):
    max_restarts = cfg.get("max_crash_restarts", 10)
    restart_count = 0

    while restart_count <= max_restarts:
        try:
            detector = ErrorDetector()
            handler  = ChallengeHandler(cfg, detector)
            notifier = Notifier(cfg)
            reader   = CalendarReader(cfg, handler, detector)

            page = bm.page
            _inner_monitor_loop(page, cfg, reader, handler, detector, notifier)
            break

        except KeyboardInterrupt:
            log("Stopped by user (Ctrl+C)")
            break

        except Exception as e:
            restart_count += 1
            log(f"Browser crashed or unexpected error: {e}", "ERROR")
            log(f"Restarting browser (restart {restart_count}/{max_restarts})...", "WARNING")
            _beep("warning")

            if restart_count > max_restarts:
                log("Max restarts exceeded — stopping", "ERROR")
                break

            bm.quit()
            time.sleep(5)

            if not bm.launch():
                log("Browser relaunch failed — waiting 30s before retry", "ERROR")
                time.sleep(30)
                continue

            page = bm.page
            log("Navigating back to OFC page after restart...")
            time.sleep(3)
            safe_goto(page, OFC_URL)
            time.sleep(5)

            content = safe_content(page).lower()
            if "sign in" in content or "log in" in content:
                log("Session lost after restart — waiting for re-login", "WARNING")
                handler_tmp = ChallengeHandler(cfg, ErrorDetector())
                wait_for_login(page, handler_tmp)

            log(f"Browser recovered ✅ — resuming monitor loop")


def _inner_monitor_loop(page: Page, cfg: ConfigManager,
                         reader: CalendarReader, handler: ChallengeHandler,
                         detector: ErrorDetector, notifier: Notifier):
    locations  = cfg.get("locations", list(LOCATIONS.keys()))
    check_num  = 0
    found_num  = 0
    keepalive  = KeepAlive(page)
    keepalive.start()

    print("\n" + "═" * 60)
    print("  MONITORING ACTIVE")
    print("  DO NOT close the browser window")
    print("  All errors (PSE0501, Cloudflare, rate limits) auto-handled")
    print("  Browser crashes auto-recover and resume")
    print("  Press Ctrl+C to stop")
    print("═" * 60 + "\n")

    try:
        while True:
            cfg.reload_if_changed()
            check_num += 1

            if not _page_alive(page):
                raise RuntimeError("Browser page became unavailable")

            try:
                if "ofc-schedule" not in safe_url(page).lower():
                    log("Not on OFC page — navigating back...")
                    safe_goto(page, OFC_URL)
                    time.sleep(5)
            except Exception:
                pass

            if not handler.handle_all(page):
                raise RuntimeError("Could not recover from browser error")

            btns = _get_loc_buttons(page)
            if not btns:
                log("No location buttons found — refreshing page", "WARNING")
                safe_goto(page, OFC_URL)
                time.sleep(6)
                handler.handle_all(page)
                btns = _get_loc_buttons(page)

            check_locs = [b for b in btns if b in locations] if btns else locations
            log(f"══ CHECK #{check_num} | Locations: {check_locs} ══")

            results = {}
            for loc_code in check_locs:
                errs = detector.detect(page)
                if "ERROR_1015" in errs:
                    handler.bypass_rate_limit(page)
                elif "SERVER_OUTAGE" in errs:
                    handler.bypass_outage(page)
                elif "CF_TURNSTILE" in errs or "CF_JS_CHALLENGE" in errs:
                    handler._handle_cf_challenge(page)
                elif "SESSION_EXPIRED" in errs:
                    handler.bypass_session_expired(page)
                elif "GENERIC_ERROR" in errs:
                    handler.bypass_generic_error(page)

                dates = reader.check_location(page, loc_code)
                results[loc_code] = dates
                time.sleep(random.uniform(2, 4))

            any_found = _print_results(results, check_num)

            if any_found:
                found_num += 1
                notifier.alert_found({k: v for k, v in results.items() if v})
                wait = 30
            else:
                int_min = cfg.get("polling_interval_min", 90)
                int_max = cfg.get("polling_interval_max", 150)
                wait    = random.randint(int_min, int_max)

            log(f"Next check in {wait}s | total={check_num} | found={found_num}x")

            for i in range(wait):
                time.sleep(1)
                if i % 10 == 0:
                    cfg.reload_if_changed()

    finally:
        keepalive.stop()
        print(f"\n  Checks: {check_num} | Slots found: {found_num}x\n")


def _print_results(results: dict, check_num: int) -> bool:
    print("\n" + "═" * 55)
    print(f"  CHECK #{check_num} | {ts()}")
    print("═" * 55)
    any_found = False
    for loc, dates in results.items():
        name = LOCATIONS.get(loc, loc)
        if dates:
            any_found = True
            print(f"  ✅ {loc} ({name}): {len(dates)} slot(s) → {dates[:6]}")
        else:
            print(f"  ❌ {loc} ({name}): No slots")
    print("═" * 55)
    return any_found


def run_single_test(page: Page, cfg: ConfigManager,
                    reader: CalendarReader, handler: ChallengeHandler,
                    detector: ErrorDetector):
    locations = cfg.get("locations", list(LOCATIONS.keys()))
    log(f"Single test check for: {locations}")
    handler.handle_all(page)
    results = {}
    for loc_code in locations:
        dates = reader.check_location(page, loc_code)
        results[loc_code] = dates
        time.sleep(random.uniform(2, 4))
    _print_results(results, 1)
    found = {k: v for k, v in results.items() if v}
    if found:
        _beep("success")
        print("\n🎉 SLOTS FOUND! Check the output above.")
    else:
        print("\n❌ No slots found in this check.")


# ══════════════════════════════════════════════════════════════════
#  CLI MENU
# ══════════════════════════════════════════════════════════════════
def main():
    print("""
╔══════════════════════════════════════════════════════════╗
║        US VISA SCHEDULING — BYPASS TOOL v4.1            ║
║  Engine: Playwright Chromium + Comprehensive Stealth   ║
║  Cloudflare + PSE0501 + Crashes — all auto-handled     ║
╚══════════════════════════════════════════════════════════╝
    """)

    if not HAS_CLOAK:
        print("  ⚠️  WARNING: CloakBrowser not installed.")
        print("     Run:  pip install cloakbrowser")
        print("     Using plain Playwright as fallback (less stealth).\n")

    cfg = ConfigManager()

    while True:
        print("─" * 50)
        print("  [1] Start Monitoring  (recommended)")
        print("  [2] Single Test Check")
        print("  [3] Refresh Login Session")
        print("  [4] Show Config")
        print("  [Q] Quit")
        print("─" * 50)

        choice = input("  Choice: ").strip().lower()

        if choice == "q":
            print("Bye!")
            break

        elif choice == "4":
            cfg.show()
            continue

        elif choice in ("1", "2", "3"):
            bm = BrowserManager(cfg)
            if not bm.launch():
                print("ERROR: Cannot launch browser.")
                print("  → Make sure Chrome/Brave is installed")
                print("  → Run: playwright install chromium")
                continue

            detector = ErrorDetector()
            handler  = ChallengeHandler(cfg, detector)
            notifier = Notifier(cfg)
            reader   = CalendarReader(cfg, handler, detector)
            page     = bm.page

            try:
                if choice == "3":
                    wait_for_login(page, handler)
                    log("Session refreshed. Browser profile updated.")
                    input("\nPress Enter to close browser...")

                elif choice == "2":
                    wait_for_login(page, handler)
                    run_single_test(page, cfg, reader, handler, detector)
                    input("\nPress Enter to close browser...")

                elif choice == "1":
                    wait_for_login(page, handler)
                    run_monitor(bm, cfg)

            except KeyboardInterrupt:
                log("Stopped by user")
            except Exception as e:
                log(f"Unexpected error: {e}", "ERROR")
            finally:
                try:
                    close = input("\nClose browser? (y/n): ").strip().lower()
                    if close == "y":
                        bm.quit()
                except Exception:
                    bm.quit()

        else:
            print("Invalid choice.")


if __name__ == "__main__":
    main()
