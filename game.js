(() => {
  "use strict";

  // Lane mapping: 0 = kiri (inner), 1 = tengah (middle), 2 = kanan (outer)
  const LANE_LABELS = ["KIRI", "TENGAH", "KANAN"];
  const LANE_KEYS = { kiri: 0, tengah: 1, kanan: 2 };

  // Success criteria: safe lane for each of 18 angular slots (1-indexed in brief → 0-indexed here)
  const SAFE_SEQUENCE = [
    "kanan",   // 1
    "kiri",    // 2
    "tengah",  // 3
    "kiri",    // 4
    "kanan",   // 5
    "kiri",    // 6
    "tengah",  // 7
    "kanan",   // 8
    "tengah",  // 9
    "kiri",    // 10
    "kanan",   // 11
    "tengah",  // 12
    "kanan",   // 13
    "kiri",    // 14
    "kanan",   // 15
    "tengah",  // 16
    "kiri",    // 17
    "tengah",  // 18
  ].map((k) => LANE_KEYS[k]);

  const SLOT_COUNT = 18;
  const SLOT_DEG = 360 / SLOT_COUNT; // 20°

  // Player sits at fixed angles (matching the reference image: left & right)
  const PLAYER_ANGLES = [180, 0]; // 9 o'clock and 3 o'clock (canvas: 0° = right, CCW)

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const scoreEl = document.getElementById("score");
  const hitsEl = document.getElementById("hits");
  const laneNameEl = document.getElementById("laneName");
  const speedInput = document.getElementById("speed");
  const speedVal = document.getElementById("speedVal");
  const btnPermission = document.getElementById("btnPermission");
  const btnStart = document.getElementById("btnStart");
  const btnReset = document.getElementById("btnReset");
  const btnAgain = document.getElementById("btnAgain");
  const overlay = document.getElementById("overlay");
  const overlayTitle = document.getElementById("overlayTitle");
  const overlayMsg = document.getElementById("overlayMsg");
  const tiltHint = document.getElementById("tiltHint");
  const laneBtns = [...document.querySelectorAll(".lane-btn")];

  // Gate angle where we evaluate pass/hit (right-side object at 3 o'clock).
  // Both red objects share the same lane; scoring uses one checkpoint.
  const GATE_ANGLE = 0;

  const state = {
    running: false,
    rotation: 0, // degrees; obstacles advance CCW
    playerLane: 1, // start tengah
    targetLane: 1,
    score: 0,
    hits: 0,
    resolved: new Set(), // slot indices already scored this lap
    lastSlotAtGate: null,
    lastTs: 0,
    degPerSec: Number(speedInput.value),
    sensorActive: false,
    betaSmooth: 0,
    finished: false,
  };

  // Precompute obstacles: for each slot, which lanes have a barrier
  // Safe lane has a gap; the other two lanes have obstacles
  const obstacles = SAFE_SEQUENCE.map((safeLane, slot) => {
    const lanes = [0, 1, 2].filter((l) => l !== safeLane);
    return { slot, safeLane, lanes };
  });

  function resize() {
    const wrap = canvas.parentElement;
    const rect = wrap.getBoundingClientRect();
    const landscape = window.matchMedia("(orientation: landscape)").matches;
    const limit = landscape ? 520 : 400;
    const cssSize = Math.max(
      140,
      Math.min(rect.width || window.innerWidth, rect.height || window.innerHeight, limit) * 0.96
    );
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssSize * dpr);
    canvas.height = Math.round(cssSize * dpr);
    canvas.style.width = `${cssSize}px`;
    canvas.style.height = `${cssSize}px`;
    draw();
  }

  function screenAngle() {
    if (screen.orientation && typeof screen.orientation.angle === "number") {
      return screen.orientation.angle;
    }
    if (typeof window.orientation === "number") return window.orientation;
    return window.innerWidth > window.innerHeight ? 90 : 0;
  }

  /** Tilt kiri/kanan relatif ke layar (portrait & landscape). */
  function screenTiltLR(e) {
    const angle = ((screenAngle() % 360) + 360) % 360;
    let v = null;
    if (angle === 90) v = e.beta;
    else if (angle === 270) v = e.beta == null ? null : -e.beta;
    else if (angle === 180) v = e.gamma == null ? null : -e.gamma;
    else v = e.gamma;
    if (v == null || Number.isNaN(v)) return null;
    return Math.max(-45, Math.min(45, v));
  }

  function laneRadius(lane, R) {
    // Inner / middle / outer track radii — supports fractional lane for smooth moves
    const ratios = [0.38, 0.58, 0.78];
    const lo = Math.max(0, Math.min(2, Math.floor(lane)));
    const hi = Math.max(0, Math.min(2, Math.ceil(lane)));
    if (lo === hi) return R * ratios[lo];
    const t = lane - lo;
    return R * (ratios[lo] * (1 - t) + ratios[hi] * t);
  }

  function polar(cx, cy, r, deg) {
    const rad = (deg * Math.PI) / 180;
    return {
      x: cx + r * Math.cos(rad),
      y: cy - r * Math.sin(rad), // canvas Y grows down; invert so +angle = CCW from +X
    };
  }

  function draw() {
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const R = w * 0.46;
    const dpr = window.devicePixelRatio || 1;
    const lineScale = Math.max(1, w / 400);

    ctx.clearRect(0, 0, w, h);

    // Board fill
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = "#7ec8e8";
    ctx.fill();

    // Track rings (black concentric lines)
    const trackRadii = [0.38, 0.58, 0.78].map((t) => R * t);
    ctx.strokeStyle = "#0d0d0d";
    ctx.lineWidth = 2.2 * lineScale;
    for (const r of trackRadii) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Soft guide rings between tracks
    ctx.strokeStyle = "rgba(0,0,0,0.18)";
    ctx.lineWidth = 1 * lineScale;
    for (const t of [0.48, 0.68]) {
      ctx.beginPath();
      ctx.arc(cx, cy, R * t, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Center hub
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.12, 0, Math.PI * 2);
    ctx.fillStyle = "#1a1a1a";
    ctx.fill();

    // Obstacles (radial black ticks), rotated CCW by state.rotation
    const tickLen = R * 0.085;
    const tickW = 5.5 * lineScale;
    ctx.strokeStyle = "#0a0a0a";
    ctx.lineCap = "butt";
    ctx.lineWidth = tickW;

    for (const obs of obstacles) {
      const baseAngle = obs.slot * SLOT_DEG + state.rotation;
      for (const lane of obs.lanes) {
        const r = laneRadius(lane, R);
        const a = baseAngle;
        const inner = polar(cx, cy, r - tickLen / 2, a);
        const outer = polar(cx, cy, r + tickLen / 2, a);
        ctx.beginPath();
        ctx.moveTo(inner.x, inner.y);
        ctx.lineTo(outer.x, outer.y);
        ctx.stroke();
      }
    }

    // Player red objects (two opposite sides)
    const playerLen = R * 0.09;
    const playerW = 6.5 * lineScale;
    const pr = laneRadius(state.playerLane, R);
    ctx.strokeStyle = "#e11d2e";
    ctx.lineWidth = playerW;
    ctx.lineCap = "butt";

    for (const pa of PLAYER_ANGLES) {
      const inner = polar(cx, cy, pr - playerLen / 2, pa);
      const outer = polar(cx, cy, pr + playerLen / 2, pa);
      ctx.beginPath();
      ctx.moveTo(inner.x, inner.y);
      ctx.lineTo(outer.x, outer.y);
      ctx.stroke();
    }

    // Tiny highlight on board edge
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 2 * lineScale;
    ctx.stroke();
  }

  function setLane(lane) {
    state.targetLane = Math.max(0, Math.min(2, lane));
    laneNameEl.textContent = LANE_LABELS[state.targetLane];
    laneBtns.forEach((b) => {
      b.classList.toggle("active", Number(b.dataset.lane) === state.targetLane);
    });
  }

  function updateHud() {
    scoreEl.textContent = String(state.score);
    hitsEl.textContent = String(state.hits);
  }

  function normalizeAngle(deg) {
    let a = deg % 360;
    if (a < 0) a += 360;
    return a;
  }

  function angleDiff(a, b) {
    let d = normalizeAngle(a) - normalizeAngle(b);
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return d;
  }

  function slotAtGate() {
    // Which obstacle slot is currently nearest the gate (player checkpoint)
    // Slot world angle = slot * 20 + rotation; we want that ≈ GATE_ANGLE
    const nearest = Math.round((GATE_ANGLE - state.rotation) / SLOT_DEG);
    return ((nearest % SLOT_COUNT) + SLOT_COUNT) % SLOT_COUNT;
  }

  function checkCollisions() {
    const slot = slotAtGate();
    const obs = obstacles[slot];
    const worldAngle = normalizeAngle(obs.slot * SLOT_DEG + state.rotation);
    const diff = Math.abs(angleDiff(worldAngle, GATE_ANGLE));

    // Only resolve once when a slot is tightly aligned with the gate
    if (diff > 6) {
      state.lastSlotAtGate = null;
      return;
    }

    if (state.resolved.has(slot) || state.lastSlotAtGate === slot) return;
    state.lastSlotAtGate = slot;

    const hit = obs.lanes.includes(state.targetLane);
    state.resolved.add(slot);

    if (hit) {
      state.hits += 1;
      flashHit();
    } else {
      state.score += 1;
    }

    updateHud();

    if (state.resolved.size >= SLOT_COUNT) {
      finish(state.hits === 0);
    }
  }

  function flashHit() {
    canvas.style.filter = "brightness(1.35) saturate(1.4)";
    setTimeout(() => {
      canvas.style.filter = "";
    }, 120);
  }

  function finish(success) {
    state.running = false;
    state.finished = true;
    overlay.hidden = false;
    if (success) {
      overlayTitle.textContent = "Berhasil!";
      overlayMsg.textContent = `Anda lolos ${state.score}/18 celah dengan ${state.hits} tabrakan.`;
    } else {
      overlayTitle.textContent = "Selesai";
      overlayMsg.textContent = `Skor: ${state.score}/18 · Tabrakan: ${state.hits}`;
    }
  }

  function resetGame() {
    state.running = false;
    // Start with first slot ~50° before the gate so player has reaction time
    state.rotation = normalizeAngle(GATE_ANGLE - 50);
    state.score = 0;
    state.hits = 0;
    state.resolved.clear();
    state.lastSlotAtGate = null;
    state.finished = false;
    state.lastTs = 0;
    setLane(1);
    state.playerLane = 1;
    overlay.hidden = true;
    updateHud();
    draw();
  }

  function startGame() {
    if (state.finished) resetGame();
    state.running = true;
    state.lastTs = 0;
    overlay.hidden = true;
    requestAnimationFrame(loop);
  }

  function loop(ts) {
    if (!state.running) return;

    if (!state.lastTs) state.lastTs = ts;
    const dt = Math.min(0.05, (ts - state.lastTs) / 1000);
    state.lastTs = ts;

    // Smooth lane transition
    state.playerLane += (state.targetLane - state.playerLane) * Math.min(1, 14 * dt);
    if (Math.abs(state.targetLane - state.playerLane) < 0.02) {
      state.playerLane = state.targetLane;
    }

    // Rotate obstacles counter-clockwise
    state.rotation = normalizeAngle(state.rotation + state.degPerSec * dt);

    checkCollisions();
    draw();
    requestAnimationFrame(loop);
  }

  // --- Device orientation (tilt) ---
  function handleOrientation(e) {
    const tilt = screenTiltLR(e);
    if (tilt == null) return;

    state.betaSmooth = state.betaSmooth * 0.75 + tilt * 0.25;

    const g = state.betaSmooth;
    if (g < -12) setLane(0); // kiri / inner
    else if (g > 12) setLane(2); // kanan / outer
    else setLane(1); // tengah
  }

  function updateTiltHint() {
    if (!tiltHint) return;
    const landscape = window.matchMedia("(orientation: landscape)").matches;
    tiltHint.querySelector("span").textContent = landscape
      ? "Miringkan HP (landscape): kiri / kanan layar"
      : "Miringkan HP kiri / kanan";
  }

  async function enableSensor() {
    try {
      if (
        typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function"
      ) {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res !== "granted") {
          alert("Izin sensor ditolak. Gunakan tombol Kiri / Tengah / Kanan.");
          return;
        }
      }

      window.addEventListener("deviceorientation", handleOrientation, true);
      state.sensorActive = true;
      btnPermission.textContent = "Sensor Aktif";
      btnPermission.disabled = true;
      btnStart.disabled = false;
      tiltHint.classList.remove("hidden");
    } catch (err) {
      console.warn(err);
      alert("Sensor tidak tersedia. Gunakan kontrol manual.");
      btnStart.disabled = false;
    }
  }

  // --- UI wiring ---
  speedInput.addEventListener("input", () => {
    state.degPerSec = Number(speedInput.value);
    speedVal.textContent = `${state.degPerSec}°/s`;
  });

  btnPermission.addEventListener("click", enableSensor);
  btnStart.addEventListener("click", startGame);
  btnReset.addEventListener("click", resetGame);
  btnAgain.addEventListener("click", () => {
    resetGame();
    startGame();
  });

  laneBtns.forEach((btn) => {
    btn.addEventListener("click", () => setLane(Number(btn.dataset.lane)));
    btn.addEventListener("touchstart", (e) => {
      e.preventDefault();
      setLane(Number(btn.dataset.lane));
    }, { passive: false });
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "a" || e.key === "A") setLane(0);
    else if (e.key === "ArrowDown" || e.key === "s" || e.key === "S" || e.key === "ArrowUp" || e.key === "w" || e.key === "W") setLane(1);
    else if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") setLane(2);
    else if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      if (!state.running) startGame();
    }
  });

  // Desktop / no-sensor: allow start immediately
  if (
    typeof DeviceOrientationEvent === "undefined" ||
    typeof DeviceOrientationEvent.requestPermission !== "function"
  ) {
    // Android / desktop often don't need permission — try listening; still allow start
    window.addEventListener("deviceorientation", handleOrientation, true);
    btnStart.disabled = false;
    btnPermission.textContent = "Cek Sensor";
  }

  function onViewportChange() {
    updateTiltHint();
    // Delay agar browser selesai mengubah layout setelah rotate
    requestAnimationFrame(() => {
      resize();
      setTimeout(resize, 250);
    });
  }

  window.addEventListener("resize", onViewportChange);
  window.addEventListener("orientationchange", onViewportChange);
  if (screen.orientation) {
    screen.orientation.addEventListener("change", onViewportChange);
  }
  updateTiltHint();

  // Prevent scroll bounce on iOS while playing
  document.body.addEventListener(
    "touchmove",
    (e) => {
      if (e.target.closest(".controls")) return;
      e.preventDefault();
    },
    { passive: false }
  );

  setLane(1);
  updateHud();
  // Initial draw offset (same as reset)
  state.rotation = normalizeAngle(GATE_ANGLE - 50);
  resize();
})();
