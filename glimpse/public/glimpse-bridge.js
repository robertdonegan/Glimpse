/**
 * Glimpse bridge — drop this into any page you demo inside Glimpse's frame
 * mode to enable full cursor magic across origins:
 *
 *   <script src="http://localhost:5173/glimpse-bridge.js"></script>
 *
 * While framed by Glimpse it streams pointer telemetry (position, clicks,
 * hover-hand) to the parent, hides the OS cursor during recording, and
 * forwards esc/backspace so the recording can be stopped from anywhere.
 * Outside a frame it does nothing.
 */
(function () {
  if (window.top === window) return;

  var styleEl = null;

  function send(msg) {
    try {
      msg.__glimpse = true;
      window.parent.postMessage(msg, '*');
    } catch (e) {
      /* parent gone */
    }
  }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.__glimpse !== true || d.type !== 'state') return;
    if (d.recording && !styleEl) {
      styleEl = document.createElement('style');
      styleEl.textContent = '*, *::before, *::after { cursor: none !important; }';
      document.head.appendChild(styleEl);
    } else if (!d.recording && styleEl) {
      styleEl.remove();
      styleEl = null;
    }
  });

  var INTERACTIVE =
    'a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], ' +
    'input, select, textarea, label, summary, [onclick], [contenteditable="true"]';

  function isHand(el) {
    if (!el || !el.closest) return false;
    if (el.closest(INTERACTIVE)) return true;
    try {
      return getComputedStyle(el).cursor === 'pointer';
    } catch (e) {
      return false;
    }
  }

  window.addEventListener(
    'pointermove',
    function (e) {
      send({
        type: 'move',
        x: e.clientX / window.innerWidth,
        y: e.clientY / window.innerHeight,
        hand: isHand(e.target),
      });
    },
    { capture: true, passive: true }
  );

  window.addEventListener(
    'pointerdown',
    function (e) {
      send({
        type: 'down',
        x: e.clientX / window.innerWidth,
        y: e.clientY / window.innerHeight,
        button: e.button,
      });
    },
    { capture: true, passive: true }
  );

  window.addEventListener(
    'keydown',
    function (e) {
      if (e.code === 'Escape' || e.code === 'Backspace' || e.code === 'Delete') {
        send({ type: 'key', code: e.code });
      }
    },
    true
  );

  send({ type: 'hello' });
})();
