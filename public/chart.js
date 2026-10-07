// Small dependency-free SVG charts (line and grouped bar) with hover tooltips.
const NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, parent) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

function niceTicks(min, max, count = 4) {
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) || 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

function legend(container, series, kind) {
  const lg = document.createElement('div');
  lg.className = 'legend';
  for (const s of series) {
    const span = document.createElement('span');
    span.innerHTML = `<i class="swatch ${kind === 'line' ? 'line' : ''}" style="background:${s.color}"></i>`;
    span.append(s.name);
    lg.appendChild(span);
  }
  container.appendChild(lg);
}

function tooltip(wrap) {
  const tt = document.createElement('div');
  tt.className = 'tooltip';
  tt.hidden = true;
  wrap.appendChild(tt);
  return {
    show(title, rows, x, y) {
      tt.innerHTML = '';
      const t = document.createElement('div');
      t.className = 'tt-title';
      t.textContent = title;
      tt.appendChild(t);
      for (const r of rows) {
        const row = document.createElement('div');
        row.className = 'tt-row';
        row.innerHTML = `<i class="swatch" style="background:${r.color}"></i>`;
        row.append(r.name);
        const b = document.createElement('b');
        b.textContent = r.value;
        row.appendChild(b);
        tt.appendChild(row);
      }
      tt.hidden = false;
      const w = wrap.clientWidth;
      const tw = tt.offsetWidth;
      tt.style.left = `${Math.max(0, Math.min(w - tw, x + 12 > w - tw ? x - tw - 12 : x + 12))}px`;
      tt.style.top = `${Math.max(0, y - 10)}px`;
    },
    hide() { tt.hidden = true; },
  };
}

/**
 * Line chart over time.
 * opts: { series: [{name, color, points: [[ms, v|null]]}], xStart, xEnd, height, unit, fmt, yMin, yMax, xLabel(ms) }
 */
export function lineChart(container, opts) {
  container.innerHTML = '';
  const series = opts.series.filter((s) => s.points.some((p) => p[1] !== null));
  if (!series.length) {
    container.innerHTML = `<p class="muted small">${opts.empty || 'No data'}</p>`;
    return;
  }
  if (series.length > 1) legend(container, series, 'line');
  const wrap = document.createElement('div');
  wrap.className = 'chart';
  container.appendChild(wrap);

  const W = Math.max(280, wrap.clientWidth || 600);
  const H = opts.height || 220;
  const m = { l: 44, r: 8, t: 8, b: 22 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const vals = series.flatMap((s) => s.points.map((p) => p[1])).filter((v) => v !== null);
  const ticks = niceTicks(opts.yMin ?? Math.min(0, ...vals), opts.yMax ?? Math.max(...vals));
  const y0 = ticks[0];
  const y1 = ticks[ticks.length - 1];
  const xs = (t) => m.l + ((t - opts.xStart) / (opts.xEnd - opts.xStart)) * iw;
  const ys = (v) => m.t + ih - ((v - y0) / (y1 - y0)) * ih;
  const fmt = opts.fmt || ((v) => `${Math.round(v)} ${opts.unit || ''}`);

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': opts.label || '' }, wrap);
  const axis = el('g', { class: 'axis' }, svg);
  for (const t of ticks) {
    el('line', { class: t === 0 ? 'zero' : 'gridline', x1: m.l, x2: W - m.r, y1: ys(t), y2: ys(t) }, axis);
    el('text', { x: m.l - 6, y: ys(t) + 4, 'text-anchor': 'end' }, axis).textContent = opts.yTick ? opts.yTick(t) : t;
  }
  const hours = (opts.xEnd - opts.xStart) / 3600e3;
  const stepH = hours <= 24 ? 6 : 24;
  for (let h = 0; h <= hours; h += stepH) {
    const t = opts.xStart + h * 3600e3;
    el('text', { x: xs(t), y: H - 4, 'text-anchor': h === 0 ? 'start' : h === hours ? 'end' : 'middle' }, axis)
      .textContent = opts.xLabel ? opts.xLabel(t) : `${String(new Date(t).getHours()).padStart(2, '0')}:00`;
  }

  for (const s of series) {
    let d = '';
    let pen = false;
    for (const [t, v] of s.points) {
      if (v === null) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${xs(t).toFixed(1)},${ys(v).toFixed(1)}`;
      pen = true;
    }
    el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
  }

  // Hover layer: crosshair + tooltip with all series at the nearest sample.
  const cross = el('line', { class: 'crosshair', y1: m.t, y2: m.t + ih, visibility: 'hidden' }, svg);
  const dots = series.map((s) => el('circle', { r: 4, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' }, svg));
  const hit = el('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' }, svg);
  const tt = tooltip(wrap);
  const times = series[0].points.map((p) => p[0]);
  const move = (clientX) => {
    const r = svg.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * W;
    const t = opts.xStart + ((px - m.l) / iw) * (opts.xEnd - opts.xStart);
    let idx = 0;
    for (let i = 1; i < times.length; i++) if (Math.abs(times[i] - t) < Math.abs(times[idx] - t)) idx = i;
    const tx = xs(times[idx]);
    cross.setAttribute('x1', tx);
    cross.setAttribute('x2', tx);
    cross.setAttribute('visibility', 'visible');
    const rows = [];
    series.forEach((s, i) => {
      const v = s.points[idx]?.[1];
      if (v === null || v === undefined) { dots[i].setAttribute('visibility', 'hidden'); return; }
      dots[i].setAttribute('cx', tx);
      dots[i].setAttribute('cy', ys(v));
      dots[i].setAttribute('visibility', 'visible');
      rows.push({ name: s.name, color: s.color, value: fmt(v) });
    });
    const d = new Date(times[idx]);
    tt.show(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, rows, (tx / W) * r.width, 0);
  };
  const leave = () => {
    cross.setAttribute('visibility', 'hidden');
    dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
    tt.hide();
  };
  hit.addEventListener('pointermove', (e) => move(e.clientX));
  hit.addEventListener('pointerdown', (e) => move(e.clientX));
  hit.addEventListener('pointerleave', leave);
}

/**
 * Grouped bar chart.
 * opts: { labels: [str], series: [{name, color, values: [num|null]}], unit, fmt, height, extraRows(i) }
 */
export function barChart(container, opts) {
  container.innerHTML = '';
  const series = opts.series;
  if (!opts.labels.length) {
    container.innerHTML = `<p class="muted small">${opts.empty || 'No data'}</p>`;
    return;
  }
  if (series.length > 1) legend(container, series, 'bar');
  const wrap = document.createElement('div');
  wrap.className = 'chart';
  container.appendChild(wrap);

  const W = Math.max(280, wrap.clientWidth || 600);
  const H = opts.height || 220;
  const m = { l: 40, r: 4, t: 8, b: 22 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const vals = series.flatMap((s) => s.values).filter((v) => v !== null);
  const ticks = niceTicks(0, Math.max(0.1, ...vals));
  const y1 = ticks[ticks.length - 1];
  const ys = (v) => m.t + ih - (v / y1) * ih;
  const fmt = opts.fmt || ((v) => `${v.toFixed(2)} ${opts.unit || ''}`);
  const n = opts.labels.length;
  const band = iw / n;
  const gap = 2;
  const groupW = Math.max(3, band * 0.78);
  const barW = Math.max(1.5, (groupW - gap * (series.length - 1)) / series.length);

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': opts.label || '' }, wrap);
  const axis = el('g', { class: 'axis' }, svg);
  for (const t of ticks) {
    el('line', { class: t === 0 ? 'zero' : 'gridline', x1: m.l, x2: W - m.r, y1: ys(t), y2: ys(t) }, axis);
    el('text', { x: m.l - 6, y: ys(t) + 4, 'text-anchor': 'end' }, axis).textContent = t;
  }
  const every = Math.ceil(n / Math.max(1, Math.floor(iw / 44)));
  opts.labels.forEach((lbl, i) => {
    if (i % every) return;
    el('text', { x: m.l + band * i + band / 2, y: H - 4, 'text-anchor': 'middle' }, axis).textContent = lbl;
  });

  const hl = el('rect', { y: m.t, height: ih, fill: 'var(--surface-2)', visibility: 'hidden' }, svg);
  svg.insertBefore(hl, axis.nextSibling);
  opts.labels.forEach((_, i) => {
    const gx = m.l + band * i + (band - groupW) / 2;
    series.forEach((s, j) => {
      const v = s.values[i];
      if (!v || v <= 0) return;
      const x = gx + j * (barW + gap);
      const y = ys(v);
      const h = m.t + ih - y;
      const r = Math.min(4, barW / 2, h);
      // Rounded data end, square at the baseline.
      el('path', {
        d: `M${x},${m.t + ih}V${y + r}Q${x},${y} ${x + r},${y}H${x + barW - r}Q${x + barW},${y} ${x + barW},${y + r}V${m.t + ih}Z`,
        fill: s.color,
      }, svg);
    });
  });

  const tt = tooltip(wrap);
  const hit = el('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' }, svg);
  const move = (clientX) => {
    const r = svg.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.floor((px - m.l) / band)));
    hl.setAttribute('x', m.l + band * i);
    hl.setAttribute('width', band);
    hl.setAttribute('visibility', 'visible');
    const rows = series.map((s) => ({ name: s.name, color: s.color, value: s.values[i] === null ? '–' : fmt(s.values[i]) }));
    if (opts.extraRows) rows.push(...opts.extraRows(i));
    tt.show(opts.titles?.[i] || opts.labels[i], rows, ((m.l + band * i + band / 2) / W) * r.width, 0);
  };
  hit.addEventListener('pointermove', (e) => move(e.clientX));
  hit.addEventListener('pointerdown', (e) => move(e.clientX));
  hit.addEventListener('pointerleave', () => { hl.setAttribute('visibility', 'hidden'); tt.hide(); });
}
