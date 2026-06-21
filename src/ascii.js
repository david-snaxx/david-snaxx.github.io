const CONFIG = {
    ramp: " ⢀⡄⢋⡟⣏⡷⣿",   // sparse -> dense; the field value picks the index
    fontSize: 15,         // px; bigger = coarser grid = fewer cells = faster
    lineHeight: 1.0,      // row spacing as a multiple of fontSize

    count: 16,            // how many blobs are alive at once
    driftAngle: 78,       // CENTER direction in degrees; 0 = right, 90 = straight up
    driftSpread: 180,     // +/- degrees of random spread per blob; 0 = all aligned, 180 = fully random
    driftSpeed: 30,       // px/sec along each blob's own direction
    waveAmp: 26,          // px/sec of sideways sway (the jitter/wave strength)
    waveFreq: 1.6,        // rad/sec — how fast each blob weaves

    blobRadius: 120,       // px; core-to-rim size of one blob
    radiusJitter: 0.45,   // +/- fraction of size variation between blobs
    life: 7,              // seconds a blob lives before fading + respawning
    lifeJitter: 0.4,      // +/- fraction of lifetime variation
    spawnTime: 3,       // seconds to ramp from invisible to full (attack / awake time)

    edgeNoiseScale: 0.02, // interior density texture (0 = smooth fill)
    shapeDeform: 0.4,     // silhouette distortion; 0 = circle, ~0.4 = organic lump
    shapeDetail: 1.6,     // lobe count; higher = more, smaller lobes
    shapeSpeed: 0.3,      // how fast the silhouette morphs over time
    trailFade: 0.12,      // bg overlay alpha; HIGHER = shorter trails
    maxAlpha: 0.6,        // ceiling so blobs never overpower the hero text
};

const canvas = document.getElementById("blob");
const ctx = canvas.getContext("2d");
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const TAU = Math.PI * 2;

// --- value noise (reused from the field demo) for organic blob edges ----------
function hash3(x, y, z) {
    let n = (x | 0) * 374761393 + (y | 0) * 668265263 + (z | 0) * 1274126177;
    n = (n ^ (n >> 13)) >>> 0;
    n = (n * 1274126177) >>> 0;
    return ((n ^ (n >> 16)) >>> 0) / 4294967295;
}

const smooth = t => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;

function noise3(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi;
    const u = smooth(xf), v = smooth(yf), w = smooth(zf);
    const c = (dx, dy, dz) => hash3(xi + dx, yi + dy, zi + dz);
    const x00 = lerp(c(0, 0, 0), c(1, 0, 0), u), x10 = lerp(c(0, 1, 0), c(1, 1, 0), u);
    const x01 = lerp(c(0, 0, 1), c(1, 0, 1), u), x11 = lerp(c(0, 1, 1), c(1, 1, 1), u);
    return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
}

//grid + canvas sizing
let cellW, cellH, dpr, blobRGB, bgRGB;

function hexToRgb(hex) {
    hex = hex.replace("#", "").trim();
    if (hex.length === 3) hex = hex.split("").map(c => c + c).join("");
    const n = parseInt(hex, 16);
    return {r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255};
}

function readColors() {
    const s = getComputedStyle(document.documentElement);
    blobRGB = s.getPropertyValue("--blob").trim() || "#e8e8ea";
    bgRGB = hexToRgb(s.getPropertyValue("--bg").trim() || "#0a0a0b");
}

function resize() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = `${CONFIG.fontSize}px ui-monospace, monospace`;
    ctx.textBaseline = "top";
    cellW = ctx.measureText("M").width;
    cellH = CONFIG.fontSize * CONFIG.lineHeight;
    // start from a solid background so the translucent trail overlay composites cleanly
    ctx.fillStyle = `rgb(${bgRGB.r},${bgRGB.g},${bgRGB.b})`;
    ctx.fillRect(0, 0, innerWidth, innerHeight);
}

//particles
const rand = (a, b) => a + Math.random() * (b - a);

function spawn(p, seeded) {
    p.x = Math.random() * innerWidth;
    p.y = Math.random() * innerHeight;
    p.age = seeded ? Math.random() * CONFIG.life : 0;  // stagger so they don't sync
    p.life = CONFIG.life * (1 + rand(-CONFIG.lifeJitter, CONFIG.lifeJitter));
    p.radius = CONFIG.blobRadius * (1 + rand(-CONFIG.radiusJitter, CONFIG.radiusJitter));
    p.phase = Math.random() * TAU;
    p.speedMul = rand(0.8, 1.2);
    p.waveMul = rand(0.6, 1.2) * (Math.random() < 0.5 ? -1 : 1);
    p.seedX = Math.random() * 1000;   // unique shape per blob
    p.seedY = Math.random() * 1000;

    // each blob picks its own travel direction: driftAngle +/- driftSpread
    const pa = (CONFIG.driftAngle + rand(-CONFIG.driftSpread, CONFIG.driftSpread)) * Math.PI / 180;
    p.dirX = Math.cos(pa);
    p.dirY = -Math.sin(pa);           // canvas y points down
    p.perpX = -p.dirY;                // wave pushes perpendicular to travel
    p.perpY = p.dirX;
    return p;
}

const particles = Array.from({length: CONFIG.count}, () => spawn({}, true));

function lifeAlpha(p) {                       // linear attack (spawnTime), long release = "trail off"
    const fadeIn = CONFIG.spawnTime > 0 ? Math.min(1, p.age / CONFIG.spawnTime) : 1;
    const fadeOut = Math.min(1, (p.life - p.age) / (0.55 * p.life));
    return Math.max(0, Math.min(fadeIn, fadeOut));
}

function drawBlob(p, t) {
    const a = lifeAlpha(p);
    if (a <= 0) return;
    const last = CONFIG.ramp.length - 1;
    const reach = p.radius * (1 + CONFIG.shapeDeform); // silhouette can bulge past radius

    const c0 = Math.max(0, Math.floor((p.x - reach) / cellW));
    const c1 = Math.min(Math.ceil(innerWidth / cellW), Math.ceil((p.x + reach) / cellW));
    const r0 = Math.max(0, Math.floor((p.y - reach) / cellH));
    const r1 = Math.min(Math.ceil(innerHeight / cellH), Math.ceil((p.y + reach) / cellH));

    for (let r = r0; r < r1; r++) {
        for (let c = c0; c < c1; c++) {
            const cx = c * cellW + cellW / 2;
            const cy = r * cellH + cellH / 2;
            const ddx = cx - p.x, ddy = cy - p.y;
            const dist = Math.hypot(ddx, ddy);

            // Per-direction radius: sample noise around the rim using the unit
            // direction (cos/sin) so the outline is seamless — no atan2, no wrap.
            let rEff = p.radius;
            if (dist > 0.0001) {
                const ux = ddx / dist, uy = ddy / dist;
                const wob = noise3(ux * CONFIG.shapeDetail + p.seedX, uy * CONFIG.shapeDetail + p.seedY, t * CONFIG.shapeSpeed);
                rEff = p.radius * (1 + CONFIG.shapeDeform * (wob * 2 - 1));
                if (rEff < p.radius * 0.15) rEff = p.radius * 0.15;
            }

            const fall = 1 - dist / rEff;            // falloff against the deformed radius
            if (fall <= 0) continue;

            const n = noise3(cx * CONFIG.edgeNoiseScale, cy * CONFIG.edgeNoiseScale, t * 0.4);
            const value = fall * (0.55 + 0.45 * n);   // interior density texture
            if (value <= 0) continue;

            const ch = CONFIG.ramp[Math.min(last, Math.floor(value * last))];
            if (ch === " ") continue;

            ctx.globalAlpha = Math.min(1, value) * a * CONFIG.maxAlpha;
            ctx.fillText(ch, c * cellW, r * cellH);
        }
    }
}

function step(dt, t) {
    for (const p of particles) {
        const wave = Math.cos(p.age * CONFIG.waveFreq + p.phase) * CONFIG.waveAmp * p.waveMul;
        const vx = p.dirX * CONFIG.driftSpeed * p.speedMul + p.perpX * wave;
        const vy = p.dirY * CONFIG.driftSpeed * p.speedMul + p.perpY * wave;
        p.x += vx * dt;
        p.y += vy * dt;
        p.age += dt;

        const m = p.radius;
        const off = p.x < -m || p.x > innerWidth + m || p.y < -m || p.y > innerHeight + m;
        if (p.age >= p.life || off) spawn(p, false);
    }
}

//loop
readColors();
resize();
addEventListener("resize", () => {
    readColors();
    resize();
});

let prev = 0;

function frame(now) {
    const t = now * 0.001;
    const dt = Math.min(0.05, prev ? t - prev : 0.016); // clamp tab-switch jumps
    prev = t;

    // trail: paint translucent bg over the previous frame instead of clearing
    ctx.globalAlpha = 1;
    ctx.fillStyle = `rgba(${bgRGB.r},${bgRGB.g},${bgRGB.b},${CONFIG.trailFade})`;
    ctx.fillRect(0, 0, innerWidth, innerHeight);

    ctx.fillStyle = blobRGB;
    step(dt, t);
    for (const p of particles) drawBlob(p, t);
    ctx.globalAlpha = 1;

    requestAnimationFrame(frame);
}

if (reduced) {
    // honour reduced-motion: one static scatter, no trails, no loop
    ctx.fillStyle = blobRGB;
    for (const p of particles) {
        p.age = p.life * 0.4;
        drawBlob(p, 0);
    }
} else {
    requestAnimationFrame(frame);
}