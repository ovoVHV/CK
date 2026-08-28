'use strict';

const VIEWPORT_TOLERANCE_PX = 1;
const NATIVE_SIZE_TOLERANCE_PX = 3;

function runtimeError(response) {
  const details = response?.exceptionDetails;
  if (!details) return null;
  return details.exception?.description || details.text || 'Runtime.evaluate failed';
}

async function restoreNativeViewport(call) {
  if (typeof call !== 'function') {
    throw new TypeError('restoreNativeViewport requires a CDP call(method, params) function');
  }

  // Device metrics are CDP-session state. A previous Playwright/CDP client can
  // leave a live Tauri WebView constrained to its synthetic width even after
  // the native window is maximized, which renders the remaining surface black.
  // Clear that state before every native regression; never emulate a viewport
  // on the user's live CK target.
  await call('Emulation.clearDeviceMetricsOverride');

  const response = await call('Runtime.evaluate', {
    expression: `(async () => {
      const internals = window.__TAURI_INTERNALS__;
      const nativeLabel = internals?.metadata?.currentWindow?.label || 'main';
      let nativeSize = null;
      let nativeSizeError = '';
      try {
        if (typeof internals?.invoke !== 'function') {
          throw new Error('Tauri invoke is unavailable');
        }
        nativeSize = await internals.invoke('plugin:window|inner_size', { label: nativeLabel });
      } catch (error) {
        nativeSizeError = String(error);
      }

      const viewport = await new Promise((resolve) => {
      const deadline = performance.now() + 3000;
      const bounds = (element) => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width };
      };
      const sample = () => requestAnimationFrame(() => requestAnimationFrame(() => {
        const root = bounds(document.querySelector('#root'));
        const app = bounds(document.querySelector('.app-root'));
        if ((!root || !app) && performance.now() < deadline) {
          setTimeout(sample, 50);
          return;
        }
        resolve({
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio,
          documentClientWidth: document.documentElement.clientWidth,
          documentScrollWidth: document.documentElement.scrollWidth,
          root,
          app,
        });
      }));
      sample();
      });
      return { ...viewport, nativeLabel, nativeSize, nativeSizeError };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const error = runtimeError(response);
  if (error) throw new Error(`Native viewport integrity check failed: ${error}`);

  const geometry = response?.result?.value;
  if (!geometry || !Number.isFinite(geometry.innerWidth) || geometry.innerWidth <= 0) {
    throw new Error('Native viewport integrity check returned no usable geometry');
  }
  const nativeWidth = Number(geometry.nativeSize?.width);
  const nativeHeight = Number(geometry.nativeSize?.height);
  if (!Number.isFinite(nativeWidth) || nativeWidth <= 0
      || !Number.isFinite(nativeHeight) || nativeHeight <= 0) {
    const detail = geometry.nativeSizeError || 'plugin:window|inner_size returned no usable size';
    throw new Error(
      `Native viewport integrity check could not read the Tauri window size (${detail}). ` +
      'Verify core:window:allow-inner-size is enabled.',
    );
  }
  const dpr = Number(geometry.devicePixelRatio);
  if (!Number.isFinite(dpr) || dpr <= 0) {
    throw new Error(`Native viewport integrity check returned an invalid devicePixelRatio: ${dpr}`);
  }
  const expectedNativeWidth = geometry.innerWidth * dpr;
  const expectedNativeHeight = geometry.innerHeight * dpr;
  const nativeWidthGap = Math.abs(nativeWidth - expectedNativeWidth);
  const nativeHeightGap = Math.abs(nativeHeight - expectedNativeHeight);
  if (nativeWidthGap > NATIVE_SIZE_TOLERANCE_PX || nativeHeightGap > NATIVE_SIZE_TOLERANCE_PX) {
    throw new Error(
      'Native WebView viewport mismatch remains after clearing CDP device metrics: ' +
      `Tauri ${nativeWidth}x${nativeHeight} physical px, ` +
      `CSS ${geometry.innerWidth}x${geometry.innerHeight} at DPR ${dpr} ` +
      `(${expectedNativeWidth}x${expectedNativeHeight} physical px). ` +
      'Restart CK or perform a real native window resize before trusting this regression.',
    );
  }
  for (const [name, rect] of Object.entries({ root: geometry.root, app: geometry.app })) {
    if (!rect) throw new Error(`Native viewport integrity check could not find ${name}`);
    const leftGap = Math.abs(rect.left);
    const rightGap = Math.abs(geometry.innerWidth - rect.right);
    if (leftGap > VIEWPORT_TOLERANCE_PX || rightGap > VIEWPORT_TOLERANCE_PX) {
      throw new Error(
        `${name} does not fill the restored native viewport ` +
        `(left gap ${leftGap.toFixed(1)}px, right gap ${rightGap.toFixed(1)}px)`,
      );
    }
  }
  return geometry;
}

module.exports = { restoreNativeViewport };
