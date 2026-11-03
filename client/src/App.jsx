import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { gu, en, num } from './i18n.js';
import { APP_ICON as iconUrl } from './app-icon-data.js';

export const APP_VERSION = '1.0.0';
const API = (typeof location !== 'undefined' ? location.origin : '') + '/api';

/* ---------- storage (guarded, in-memory fallback) ---------- */
const mem = {};
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return mem[k] ?? null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { mem[k] = v; } },
  del(k) { try { localStorage.removeItem(k); } catch { delete mem[k]; } },
  sget(k) { try { return sessionStorage.getItem(k); } catch { return mem['s:' + k] ?? null; } },
  sset(k, v) { try { sessionStorage.setItem(k, v); } catch { mem['s:' + k] = v; } },
};

/* ---------- api ---------- */
async function api(action, args = {}, token) {
  const r = await fetch(API, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, args, token }),
  });
  const j = await r.json().catch(() => ({ ok: false, error: 'server_error' }));
  if (!j.ok) { const e = new Error(j.error || 'server_error'); e.code = j.error || 'server_error'; throw e; }
  return j;
}

/* ---------- dates / versions ---------- */
const pad = (n) => String(n).padStart(2, '0');
export function isoLocal(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function addDaysISO(iso, n) { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return isoLocal(d); }
function parseVersion(v) { return String(v || '').replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0); }
function isNewerVersion(latest, current) {
  if (!latest) return false;
  const a = parseVersion(latest), b = parseVersion(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x > y) return true; if (x < y) return false;
  }
  return false;
}
function fmtDur(mins, t, N) {
  const h = Math.floor((mins || 0) / 60), m = (mins || 0) % 60;
  if (h && m) return `${N(h)} ${t.hours} ${N(m)} ${t.minutes}`;
  if (h) return `${N(h)} ${t.hours}`;
  return `${N(m)} ${t.minutes}`;
}
function fmtDate(iso, lang) {
  try { return new Date(iso + 'T12:00:00').toLocaleDateString(lang === 'gu' ? 'gu-IN' : 'en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }); }
  catch { return iso; }
}

/* ---------- sound + vibration + OS notification ---------- */
let AC = null;
function audioCtx() {
  if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)();
  if (AC.state === 'suspended') AC.resume();
  return AC;
}
export function playChime() {
  try {
    const ctx = audioCtx(), t0 = ctx.currentTime;
    [880, 1174.66].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      const s = t0 + i * 0.18;
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.25, s + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.6);
      o.connect(g); g.connect(ctx.destination); o.start(s); o.stop(s + 0.65);
    });
  } catch { /* no audio */ }
}
export function playTempleBell() {
  try {
    const ctx = audioCtx();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.connect(ctx.destination);
    const strike = (t0) => {
      const base = 392;
      [1, 2.02, 2.74, 3.76, 5.4].forEach((p, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = base * p;
        const peak = i === 0 ? 0.85 : 0.45 / i;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.4);
        o.connect(g); g.connect(comp); o.start(t0); o.stop(t0 + 2.5);
      });
    };
    const now = ctx.currentTime + 0.03;
    strike(now); strike(now + 0.8); strike(now + 1.6); // three loud strikes
  } catch { /* no audio */ }
}
export function vibrate(pattern) { try { if (navigator.vibrate) navigator.vibrate(pattern); } catch { /* unsupported */ } }
export function osNotify(title, body) {
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body, icon: iconUrl });
    }
  } catch { /* unsupported */ }
}

/* ---------- wheel time picker (touch + mouse wheel + click + steppers + keyboard) ---------- */
function Wheel({ items, index, onPick, render }) {
  const ref = useRef(null);
  const H = 38;
  useEffect(() => {
    const el = ref.current; if (!el) return;
    if (Math.abs(el.scrollTop - index * H) > 2) el.scrollTo({ top: index * H, behavior: 'auto' });
  }, [index]);
  const onScroll = () => {
    const el = ref.current; if (!el) return;
    const i = Math.max(0, Math.min(items.length - 1, Math.round(el.scrollTop / H)));
    if (i !== index) onPick(i);
  };
  return (
    <div className="wheel">
      <div className="wstep"><button type="button" aria-label="up" onClick={() => onPick(Math.max(0, index - 1))}>▲</button></div>
      <div className="wlist" ref={ref} onScroll={onScroll} tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); onPick(Math.min(items.length - 1, index + 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); onPick(Math.max(0, index - 1)); }
        }}>
        {items.map((it, i) => (
          <div key={i} className={'witem' + (i === index ? ' on' : '')}
            onClick={() => { onPick(i); ref.current && ref.current.scrollTo({ top: i * H, behavior: 'smooth' }); }}>
            {render(it)}
          </div>
        ))}
      </div>
      <div className="wstep"><button type="button" aria-label="down" onClick={() => onPick(Math.min(items.length - 1, index + 1))}>▼</button></div>
    </div>
  );
}

// value: { h: 1-12, m: 0-59, ap: 'AM'|'PM' } ; onDone(value) or onDone(null) = clear
export function TimeWheelPopup({ t, N, value, allowClear, onDone, onClose }) {
  const hours = Array.from({ length: 12 }, (_, i) => i + 1);
  const mins = Array.from({ length: 60 }, (_, i) => i);
  const aps = ['AM', 'PM'];
  const [hi, setHi] = useState(() => Math.max(0, hours.indexOf(value?.h || 5)));
  const [mi, setMi] = useState(value?.m || 0);
  const [ai, setAi] = useState(() => (value?.ap === 'PM' ? 1 : 0));
  return (
    <div className="wheelpop" onClick={onClose}>
      <div className="wheelcard" onClick={(e) => e.stopPropagation()}>
        <div className="wheels">
          <Wheel items={hours} index={hi} onPick={setHi} render={(h) => N(h)} />
          <Wheel items={mins} index={mi} onPick={setMi} render={(m) => N(pad(m))} />
          <Wheel items={aps} index={ai} onPick={setAi} render={(a) => a} />
        </div>
        <div className="wheelactions">
          {allowClear
            ? <button type="button" className="btn ghost small" onClick={() => onDone(null)}>{t.clearT}</button>
            : <span />}
          <span style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn ghost small" onClick={onClose}>{t.cancel}</button>
            <button type="button" className="btn small" onClick={() => onDone({ h: hours[hi], m: mins[mi], ap: aps[ai] })}>{t.ok}</button>
          </span>
        </div>
      </div>
    </div>
  );
}
export function timeObjToStr(o) { return o ? `${o.h}:${pad(o.m)} ${o.ap}` : null; }
export function strToTimeObj(s) {
  if (!s) return null;
  const m = String(s).match(/^(0?[1-9]|1[0-2]):([0-5][0-9])\s?(AM|PM)$/i);
  if (!m) return null;
  return { h: Number(m[1]), m: Number(m[2]), ap: m[3].toUpperCase() };
}
export function timeObjTo24(o) { let h = o.h % 12; if (o.ap === 'PM') h += 12; return `${pad(h)}:${pad(o.m)}`; }
export function hhmm24ToObj(s) {
  const [H, M] = String(s || '21:00').split(':').map(Number);
  const ap = H >= 12 ? 'PM' : 'AM'; const h = H % 12 === 0 ? 12 : H % 12;
  return { h, m: M || 0, ap };
}

/* ---------- small form components ---------- */
export function Seg({ value, options, onChange, disabled }) {
  return (
    <div className="seg" role="group">
      {options.map((o) => (
        <button type="button" key={o.v} disabled={disabled}
          className={value === o.v ? 'on ' + (o.cls || '') : ''}
          onClick={() => onChange(o.v)}>{o.label}</button>
      ))}
    </div>
  );
}
export function Stepper({ value, onChange, min = 0, max, disabled }) {
  const clamp = (v) => { let n = Math.max(min, v); if (max !== undefined && max !== null) n = Math.min(max, n); return n; };
  return (
    <div className="stepper">
      <button type="button" disabled={disabled} onClick={() => onChange(clamp((value || 0) - 1))}>−</button>
      <input type="number" inputMode="numeric" disabled={disabled} value={value ?? 0} min={min} max={max}
        onChange={(e) => onChange(clamp(Math.floor(Number(e.target.value) || 0)))} />
      <button type="button" disabled={disabled} onClick={() => onChange(clamp((value || 0) + 1))}>+</button>
    </div>
  );
}
export function DurationStepper({ minutes, onChange, t, disabled }) {
  const h = Math.floor((minutes || 0) / 60), m = (minutes || 0) % 60;
  return (
    <span className="dur">
      <Stepper disabled={disabled} value={h} onChange={(v) => onChange(v * 60 + m)} />
      <span className="unit">{t.hourUnit}</span>
      <Stepper disabled={disabled} value={m} onChange={(v) => onChange(h * 60 + Math.min(59, v))} />
      <span className="unit">{t.minUnit}</span>
    </span>
  );
}
export function Switch({ checked, onChange, disabled }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="tk" />
    </label>
  );
}

/* ---------- full read-only report detail (history + group feed) ---------- */
export function DetailGrid({ data, t, N, customDefs }) {
  if (!data) return null;
  const chip = (v) => v
    ? <span className="chip g">{t.yes}</span>
    : <span className="chip r">{t.no}</span>;
  const dhyanChip = data.dhyan === 'done' ? <span className="chip g">{t.done}</span>
    : data.dhyan === 'partial' ? <span className="chip y">{t.partial} · {N(data.dhyanMinutes || 0)} {t.minUnit}</span>
    : <span className="chip r">{t.notDone}</span>;
  const rows = [
    [t.wakeTime, data.wakeTime || '—'],
    [t.mangala, chip(data.mangala)],
    [t.dhyan, dhyanChip],
    [t.katha, chip(data.katha)],
    [t.vachanamrut, chip(data.vachanamrut)],
    [t.chesta, chip(data.chesta)],
    [t.mandir, chip(data.mandir)],
    [t.dandvat, N(data.dandvat || 0)],
    [t.bhajan, fmtDur(data.bhajanMinutes, t, N)],
    [t.dhun, fmtDur(data.dhunMinutes, t, N)],
    [t.pradakshina, `${N(data.pradakshina || 0)}${data.pradakshinaPlace ? ' · ' + data.pradakshinaPlace : ''}`],
    [t.mansiPuja, `${N(data.mansiPuja || 0)} / ${N(5)}`],
    [t.sleepTime, data.sleepTime || '—'],
    [t.vvrat, data.vvrat === 'yes' ? <span className="chip g">{t.yes}</span> : data.vvrat === 'no' ? <span className="chip r">{t.no}</span> : '—'],
  ];
  for (const f of customDefs || []) {
    const v = data[f.key];
    if (v === undefined || v === null) continue;
    rows.push([f.label, f.kind === 'toggle' ? chip(!!v) : f.kind === 'count' ? N(v || 0) : fmtDur(v || 0, t, N)]);
  }
  if (data.vvratNote) rows.push([t.vvrat, data.vvratNote]);
  if (data.mantavya) rows.push([t.mantavya, data.mantavya]);
  return (
    <div className="detailgrid">
      {rows.map(([k, v], i) => <div key={i}><span>{k}</span><b>{v}</b></div>)}
    </div>
  );
}

/* ---------- SVG line chart ---------- */
export function LineChart({ points, max, t, N, greenAtFull }) {
  const W = 640, H = 170, P = 26;
  const iw = W - P * 2, ih = H - P * 2;
  const x = (i) => P + (points.length <= 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const y = (v) => P + ih - (v / max) * ih;
  const runs = [];
  let cur = [];
  points.forEach((p, i) => { if (p.y === null || p.y === undefined) { if (cur.length) runs.push(cur); cur = []; } else cur.push(i); });
  if (cur.length) runs.push(cur);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }} role="img">
      <line x1={P} y1={y(0)} x2={W - P} y2={y(0)} stroke="var(--line)" strokeWidth="1" />
      <line x1={P} y1={y(max)} x2={W - P} y2={y(max)} stroke="var(--line)" strokeWidth="1" strokeDasharray="4 4" />
      <text x={4} y={y(max) + 4} fontSize="11" fill="var(--ink2)">{N(max)}</text>
      <text x={4} y={y(0) + 4} fontSize="11" fill="var(--ink2)">{N(0)}</text>
      {runs.map((run, ri) => run.length > 1 ? (
        <polyline key={ri} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinejoin="round"
          points={run.map((i) => `${x(i)},${y(points[i].y)}`).join(' ')} />
      ) : null)}
      {points.map((p, i) => (p.y === null || p.y === undefined) ? (
        <circle key={i} cx={x(i)} cy={y(0)} r="4.5" fill="none" stroke="var(--red)" strokeWidth="2" />
      ) : (
        <circle key={i} cx={x(i)} cy={y(p.y)} r="4.5"
          fill={greenAtFull && p.y >= max ? 'var(--green)' : greenAtFull ? 'var(--red)' : 'var(--accent)'}
          stroke="var(--card)" strokeWidth="1.5">
          <title>{p.label}: {N(p.y)}</title>
        </circle>
      ))}
    </svg>
  );
}

/* ================= AUTH ================= */
function LangThemeRow({ lang, setLang, theme, setTheme, t }) {
  return (
    <div className="langtheme">
      <button type="button" className={'pill' + (lang === 'gu' ? ' on' : '')} onClick={() => setLang('gu')}>ગુજરાતી</button>
      <button type="button" className={'pill' + (lang === 'en' ? ' on' : '')} onClick={() => setLang('en')}>EN</button>
      <button type="button" className="pill" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="theme">
        {theme === 'dark' ? '☀️' : '🌙'}
      </button>
    </div>
  );
}

function eventText(e, t) {
  if (e.type === 'join_request') {
    return { title: t.evReqTitle, body: t.evReqBody.replace('{name}', e.actorName || '').replace('{group}', e.groupName || '') };
  }
  if (e.type === 'join_approved') {
    return { title: t.evApprTitle, body: t.evApprBody.replace('{group}', e.groupName || '') };
  }
  return { title: t.appNameGu, body: e.groupName || '' };
}

function errText(e, t) {
  switch (e.code) {
    case 'invalid_credentials': return t.errInvalid;
    case 'email_taken': return t.errTaken;
    case 'weak_password': return t.errWeak;
    case 'invalid_code': return t.errCode;
    case 'locked': return t.errLocked;
    case 'owner_immutable': return t.errOwnerImmutable;
    case 'already_member': return t.errAlreadyMember;
    case 'name_cooldown': return t.nameRule;
    case 'too_many_fields': return t.errTooManyFields;
    default: return t.errGeneric;
  }
}

export function BackupCodesScreen({ codes, t, onDone }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(codes.join('\n')); setCopied(true); } catch { /* clipboard blocked */ }
  };
  return (
    <div className="authwrap">
      <div className="card authcard">
        <h2 style={{ marginTop: 0 }}>{t.codesTitle} 🔐</h2>
        <p className="small" style={{ fontSize: 14 }}>{t.codesWarn}</p>
        <div className="codes">{codes.map((c) => <code key={c}>{c}</code>)}</div>
        <button type="button" className="btn ghost" onClick={copy}>{copied ? t.copied : t.copyAll}</button>
        <div style={{ marginTop: 14 }}>
          <button type="button" className="btn" onClick={onDone}>{t.codesSavedBtn}</button>
        </div>
      </div>
    </div>
  );
}

export function AuthScreen({ t, lang, setLang, theme, setTheme, onAuthed }) {
  const [mode, setMode] = useState('login'); // login | signup | recover
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [invite, setInvite] = useState(null); // group preview for an invite link

  useEffect(() => {
    const c = store.get('dn-join-code');
    if (c) api('groupPreview', { code: c }).then((r) => setInvite(r)).catch(() => { /* stale code */ });
  }, []);

  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      if (mode === 'signup') {
        const r = await api('signup', { name, email, password });
        onAuthed(r, true); // shows backup codes screen first
      } else if (mode === 'login') {
        const r = await api('login', { email, password });
        onAuthed(r, false);
      } else {
        await api('recoverWithBackupCode', { email, code, newPassword });
        setMode('login'); setPassword(''); setErr(''); setCode('');
        alert(t.savedOk);
      }
    } catch (e2) { setErr(errText(e2, t)); }
    setBusy(false);
  };

  return (
    <div className="authwrap">
      <div className="card authcard">
        <LangThemeRow lang={lang} setLang={setLang} theme={theme} setTheme={setTheme} t={t} />
        <img className="logo" src={iconUrl} alt="Daily Niyam" />
        <h1 style={{ margin: '10px 0 0' }}>{t.appNameGu}</h1>
        <div className="tagline">{t.tagline}</div>
        <div className="motto" style={{ fontSize: 16, marginTop: 8 }}>{t.motto}</div>
        {lang === 'en' && t.mottoEn ? <div className="motto-en">{t.mottoEn}</div> : null}
        {invite && (
          <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 12, background: 'var(--accent-soft, #FBE3C2)', fontSize: 14.5, fontWeight: 600 }}>
            {t.inviteBanner.replace('{group}', invite.name)}
          </div>
        )}
        <form onSubmit={submit} style={{ marginTop: 18 }}>
          {mode === 'signup' && (
            <div className="field"><label>{t.name}</label>
              <input className="textin" value={name} onChange={(e) => setName(e.target.value)} required /></div>
          )}
          <div className="field"><label>{t.email}</label>
            <input className="textin" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
          {mode !== 'recover' && (
            <div className="field"><label>{t.password}</label>
              <input className="textin" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
          )}
          {mode === 'recover' && (<>
            <div className="field"><label>{t.backupCode}</label>
              <input className="textin" value={code} onChange={(e) => setCode(e.target.value)} required placeholder="XXXX-XXXX" /></div>
            <div className="field"><label>{t.newPassword}</label>
              <input className="textin" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required /></div>
          </>)}
          {err ? <div className="err">{err}</div> : null}
          <button className="btn" type="submit" disabled={busy} style={{ width: '100%' }}>
            {busy ? t.saving : mode === 'signup' ? t.signupBtn : mode === 'recover' ? t.recoverBtn : t.loginBtn}
          </button>
        </form>
        <div style={{ marginTop: 10 }}>
          {mode === 'login' && (<>
            <button type="button" className="linkbtn" onClick={() => { setMode('signup'); setErr(''); }}>{t.noAccount}</button><br />
            <button type="button" className="linkbtn" onClick={() => { setMode('recover'); setErr(''); }}>{t.forgot}</button>
          </>)}
          {mode === 'signup' && <button type="button" className="linkbtn" onClick={() => { setMode('login'); setErr(''); }}>{t.haveAccount}</button>}
          {mode === 'recover' && <button type="button" className="linkbtn" onClick={() => { setMode('login'); setErr(''); }}>← {t.back}</button>}
        </div>
      </div>
    </div>
  );
}

/* ================= REPORT FORM ================= */
const EMPTY_REPORT = {
  wakeTime: null, mangala: false, dhyan: null, dhyanMinutes: 0,
  katha: false, vachanamrut: false, chesta: false, mandir: false, dandvat: 0,
  bhajanMinutes: 0, dhunMinutes: 0, pradakshina: 0, pradakshinaPlace: '', mansiPuja: 0,
  sleepTime: null, mantavya: '', vvrat: null, vvratNote: '',
};
export function completionOf(d, cfg) {
  if (!d) return 0;
  const hidden = new Set((cfg && cfg.hidden) || []);
  let total = 0, n = 0;
  const item = (key, done) => { if (hidden.has(key)) return; total++; if (done) n++; };
  item('mangala', !!d.mangala);
  item('dhyan', d.dhyan === 'done' || d.dhyan === 'partial');
  item('katha', !!d.katha); item('vachanamrut', !!d.vachanamrut);
  item('chesta', !!d.chesta); item('mandir', !!d.mandir);
  item('dandvat', (d.dandvat || 0) > 0); item('bhajan', (d.bhajanMinutes || 0) > 0);
  item('dhun', (d.dhunMinutes || 0) > 0); item('pradakshina', (d.pradakshina || 0) > 0);
  item('mansiPuja', (d.mansiPuja || 0) > 0);
  item('vvrat', d.vvrat === 'yes');
  for (const f of (cfg && cfg.fields) || []) {
    total++;
    const v = d[f.key];
    if (f.kind === 'toggle' ? !!v : (Number(v) || 0) > 0) n++;
  }
  return total ? Math.round((n / total) * 100) : 0;
}

function TimeField({ label, value, onChange, t, N, defaultAp, disabled }) {
  const [open, setOpen] = useState(false);
  const obj = strToTimeObj(value) || { h: 5, m: 30, ap: defaultAp || 'AM' };
  return (
    <div className="fcard">
      <div className="lab">{label}</div>
      <button type="button" className="timebtn" disabled={disabled} onClick={() => setOpen(true)}>
        <span className="ticon">🕐</span>{value ? value.replace(/(\d+):(\d+)/, (m0, h, m) => `${N(h)}:${N(m)}`) : '--:--'}
      </button>
      {open && (
        <TimeWheelPopup t={t} N={N} value={obj} allowClear={!!value}
          onClose={() => setOpen(false)}
          onDone={(o) => { setOpen(false); onChange(timeObjToStr(o)); }} />
      )}
    </div>
  );
}

function Ring({ pct, N }) {
  const r = 52, c = 2 * Math.PI * r;
  const col = pct >= 100 ? 'var(--green)' : 'var(--brand)';
  return (
    <div className="ring" aria-hidden="true">
      <svg viewBox="0 0 120 120">
        <circle className="ringtrack" cx="60" cy="60" r={r} />
        <circle className="ringprog" cx="60" cy="60" r={r} stroke={col}
          strokeDasharray={c} strokeDashoffset={c - (c * Math.max(0, Math.min(100, pct))) / 100} />
      </svg>
      <div className="ringpct" style={{ color: col }}>{N(pct)}%</div>
    </div>
  );
}

export function ReportForm({ token, t, N, lang, date, setDate, onSaved, reportConfig }) {
  const [data, setData] = useState(EMPTY_REPORT);
  const [existing, setExisting] = useState(null); // server report row wrapper
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);
  const pct = completionOf(data, reportConfig);
  const hidden = (reportConfig && reportConfig.hidden) || [];
  const locked = !!existing && !existing.editable;

  const load = useCallback(async () => {
    try {
      const r = await api('getReport', { date }, token);
      if (r.report) { setExisting(r.report); setData({ ...EMPTY_REPORT, ...r.report.data }); }
      else { setExisting(null); setData(EMPTY_REPORT); }
    } catch { /* offline */ }
  }, [date, token]);
  useEffect(() => { load(); }, [load]);
  // re-check editability every 20s so the form locks itself when the 5 minutes pass
  useEffect(() => {
    if (!existing) return;
    const id = setInterval(() => {
      setExisting((ex) => ex ? { ...ex, editable: Date.now() < ex.editDeadline } : ex);
    }, 20000);
    return () => clearInterval(id);
  }, [existing?.editDeadline]);

  const set = (k, v) => setData((d) => ({ ...d, [k]: v }));
  const save = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api('saveReport', { date, ...data }, token);
      setExisting(r.report); setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2500);
      if (onSaved) onSaved();
    } catch (e) {
      if (e.code === 'edit_window_expired') { setErr(t.lockedNote); load(); }
      else setErr(t.errGeneric);
    }
    setBusy(false);
  };

  const toggleOpts = [{ v: true, label: t.yes }, { v: false, label: t.no, cls: 'no' }];
  const triOpts = [{ v: 'done', label: t.done }, { v: 'partial', label: t.partial, cls: 'part' }, { v: 'no', label: t.notDone, cls: 'no' }];

  return (
    <div>
      <div className="card hero">
        <div className="motto">{t.motto}</div>
        {lang === 'en' && t.mottoEn ? <div className="motto-en">{t.mottoEn}</div> : null}
        <div className="herorow">
          <Ring pct={pct} N={N} />
          <div className="heroright">
            <div className="herodate">{fmtDate(date, lang)}</div>
            <div className="herosub">{t.dayProgress} · {N(pct)}% {t.percentDone}</div>
            <div className="datechiprow">
              <span className="datelab">{t.date}</span>
              <span className="datechip">
                <input type="date" value={date} max={isoLocal()}
                  onChange={(e) => setDate(e.target.value)} />
              </span>
            </div>
          </div>
        </div>
        {existing
          ? <div className="banner inhero">{t.submittedBanner}</div>
          : <div className="notice">{t.noReport}</div>}
      </div>

      {locked ? <div className="locknote">🔒 {t.lockedNote}</div> : null}
      {err ? <div className="err">{err}</div> : null}

      <fieldset className="fcards" disabled={locked}>
          <TimeField label={t.wakeTime} value={data.wakeTime} onChange={(v) => set('wakeTime', v)} t={t} N={N} defaultAp="AM" disabled={locked} />
          <div className="fcard" hidden={hidden.includes('mangala')}><div className="lab">{t.mangala}</div>
            <Seg value={data.mangala} options={toggleOpts} onChange={(v) => set('mangala', v)} disabled={locked} /></div>
          <div className="fcard stack" hidden={hidden.includes('dhyan')}><div className="lab">{t.dhyan}</div>
            <Seg value={data.dhyan} options={triOpts} onChange={(v) => set('dhyan', v)} disabled={locked} />
          {data.dhyan === 'partial' && (
            <div className="frow"><div className="lab"><small>{t.ketliMin}</small></div>
              <Stepper value={data.dhyanMinutes} onChange={(v) => set('dhyanMinutes', v)} disabled={locked} /></div>
          )}
          </div>
          <div className="fcard" hidden={hidden.includes('katha')}><div className="lab">{t.katha}</div>
            <Seg value={data.katha} options={toggleOpts} onChange={(v) => set('katha', v)} disabled={locked} /></div>
          <div className="fcard" hidden={hidden.includes('vachanamrut')}><div className="lab">{t.vachanamrut}</div>
            <Seg value={data.vachanamrut} options={toggleOpts} onChange={(v) => set('vachanamrut', v)} disabled={locked} /></div>
          <div className="fcard" hidden={hidden.includes('chesta')}><div className="lab">{t.chesta}</div>
            <Seg value={data.chesta} options={toggleOpts} onChange={(v) => set('chesta', v)} disabled={locked} /></div>
          <div className="fcard" hidden={hidden.includes('mandir')}><div className="lab">{t.mandir}</div>
            <Seg value={data.mandir} options={toggleOpts} onChange={(v) => set('mandir', v)} disabled={locked} /></div>
          <div className="fcard" hidden={hidden.includes('dandvat')}><div className="lab">{t.dandvat}<small>{t.ketla}</small></div>
            <Stepper value={data.dandvat} onChange={(v) => set('dandvat', v)} disabled={locked} /></div>
          <div className="fcard" hidden={hidden.includes('bhajan')}><div className="lab">{t.bhajan}<small>{t.total}: {fmtDur(data.bhajanMinutes, t, N)}</small></div>
            <DurationStepper minutes={data.bhajanMinutes} onChange={(v) => set('bhajanMinutes', v)} t={t} disabled={locked} /></div>
          <div className="fcard" hidden={hidden.includes('dhun')}><div className="lab">{t.dhun}<small>{t.total}: {fmtDur(data.dhunMinutes, t, N)}</small></div>
            <DurationStepper minutes={data.dhunMinutes} onChange={(v) => set('dhunMinutes', v)} t={t} disabled={locked} /></div>
          <div className="fcard stack" hidden={hidden.includes('pradakshina')}><div className="frow"><div className="lab">{t.pradakshina}<small>{t.ketli}</small></div>
            <Stepper value={data.pradakshina} onChange={(v) => set('pradakshina', v)} disabled={locked} /></div>
          <div className="frow"><div className="lab"><small>{t.whereDid}</small></div>
            <input className="textin" style={{ maxWidth: 260 }} value={data.pradakshinaPlace} placeholder={t.placePlaceholder}
              onChange={(e) => set('pradakshinaPlace', e.target.value)} disabled={locked} /></div>
          </div>
          <div className="fcard" hidden={hidden.includes('mansiPuja')}><div className="lab">{t.mansiPuja}<small>{t.ketli}</small></div>
            <Stepper value={data.mansiPuja} max={5} onChange={(v) => set('mansiPuja', v)} disabled={locked} />
            <span className="unit">{N(data.mansiPuja || 0)} / {N(5)}</span></div>
          {((reportConfig && reportConfig.fields) || []).map((f) => (
            <div className="fcard" key={f.key}><div className="lab">{f.label}</div>
              {f.kind === 'toggle'
                ? <Seg value={!!data[f.key]} options={toggleOpts} onChange={(v) => set(f.key, v)} disabled={locked} />
                : f.kind === 'count'
                  ? <Stepper value={data[f.key] || 0} onChange={(v) => set(f.key, v)} disabled={locked} />
                  : <DurationStepper minutes={data[f.key] || 0} onChange={(v) => set(f.key, v)} t={t} disabled={locked} />}
            </div>
          ))}
          <TimeField label={t.sleepTime} value={data.sleepTime} onChange={(v) => set('sleepTime', v)} t={t} N={N} defaultAp="PM" disabled={locked} />
          <div className="fcard stack wide"><div className="lab">{t.mantavya}</div>
            <textarea className="textin" value={data.mantavya} placeholder={t.mantavyaPlaceholder}
              onChange={(e) => set('mantavya', e.target.value)} disabled={locked} /></div>
          <div className="fcard stack" hidden={hidden.includes('vvrat')}><div className="frow"><div className="lab">{t.vvrat}</div>
            <Seg value={data.vvrat} options={[{ v: 'yes', label: t.yes }, { v: 'no', label: t.no, cls: 'no' }]}
              onChange={(v) => set('vvrat', v)} disabled={locked} /></div>
          <div className="frow"><div className="lab"><small>{t.vvratNote}</small></div>
            <input className="textin" style={{ maxWidth: 260 }} value={data.vvratNote}
              onChange={(e) => set('vvratNote', e.target.value)} disabled={locked} /></div>
          </div>
      </fieldset>

      {!locked && (
        <div className="savebar">
          <button type="button" className="btn savebtn" disabled={busy} onClick={save}>
            {busy ? t.saving : savedFlash ? t.savedOk : t.save}
          </button>
        </div>
      )}
    </div>
  );
}

/* ================= PROGRESS ================= */
export function ProgressView({ reports, t, N, lang }) {
  const byDate = useMemo(() => { const m = {}; for (const r of reports) m[r.date] = r; return m; }, [reports]);
  const today = isoLocal();
  const last30 = useMemo(() => {
    const out = [];
    for (let i = 29; i >= 0; i--) {
      const d = addDaysISO(today, -i);
      const r = byDate[d];
      out.push({ date: d, completion: r ? r.completion : null, bhajan: r ? (r.data.bhajanMinutes || 0) : null });
    }
    return out;
  }, [byDate, today]);
  const stats = useMemo(() => {
    let streak = 0;
    let cursor = byDate[today] ? today : addDaysISO(today, -1);
    while (byDate[cursor]) { streak++; cursor = addDaysISO(cursor, -1); }
    const comps = last30.filter((d) => d.completion !== null).map((d) => d.completion);
    const avg = comps.length ? Math.round(comps.reduce((a, b) => a + b, 0) / comps.length) : 0;
    const totalBhajan = reports.reduce((a, r) => a + (r.data.bhajanMinutes || 0), 0);
    return { streak, avg, totalBhajan, count: reports.length };
  }, [byDate, last30, reports, today]);

  const [calYM, setCalYM] = useState(() => today.slice(0, 7));
  const calDays = useMemo(() => {
    const [Y, M] = calYM.split('-').map(Number);
    const first = new Date(Y, M - 1, 1);
    const daysIn = new Date(Y, M, 0).getDate();
    const cells = [];
    for (let i = 0; i < first.getDay(); i++) cells.push(null);
    for (let d = 1; d <= daysIn; d++) cells.push(`${calYM}-${pad(d)}`);
    return cells;
  }, [calYM]);
  const shiftMonth = (n) => {
    const [Y, M] = calYM.split('-').map(Number);
    const d = new Date(Y, M - 1 + n, 1);
    setCalYM(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
  };

  return (
    <div>
      <div className="stats" style={{ marginBottom: 14 }}>
        <div className="stat"><b>{N(stats.streak)}</b><span>{t.streak}</span></div>
        <div className="stat"><b>{N(stats.avg)}%</b><span>{t.average}</span></div>
        <div className="stat"><b>{fmtDur(stats.totalBhajan, t, N)}</b><span>{t.totalBhajan}</span></div>
        <div className="stat"><b>{N(stats.count)}</b><span>{t.reportsCount}</span></div>
      </div>
      <div className="grid2">
        <div className="card">
          <h3 className="sec">{t.last30} (%)</h3>
          <LineChart greenAtFull max={100} t={t} N={N}
            points={last30.map((d) => ({ y: d.completion, label: fmtDate(d.date, lang) }))} />
          <div className="legend">
            <span><span className="dot" style={{ background: 'var(--green)' }} />{N(100)}%</span>
            <span><span className="dot" style={{ background: 'var(--red)' }} />&lt; {N(100)}%</span>
            <span>○ {t.noReportDay}</span>
          </div>
        </div>
        <div className="card">
          <h3 className="sec">{t.bhajanGraph}</h3>
          <LineChart greenAtFull={false} max={Math.max(60, ...last30.map((d) => d.bhajan || 0))} t={t} N={N}
            points={last30.map((d) => ({ y: d.bhajan, label: fmtDate(d.date, lang) }))} />
        </div>
      </div>
      <div className="card">
        <div className="calhead">
          <button type="button" className="btn ghost small" onClick={() => shiftMonth(-1)}>‹</button>
          <b>{new Date(calYM + '-15T12:00:00').toLocaleDateString(lang === 'gu' ? 'gu-IN' : 'en-IN', { month: 'long', year: 'numeric' })}</b>
          <button type="button" className="btn ghost small" onClick={() => shiftMonth(1)}>›</button>
        </div>
        <div className="cal">
          {calDays.map((d, i) => {
            if (!d) return <div key={i} className="d none" />;
            const r = byDate[d];
            const cls = r ? (r.completion >= 100 ? 'full' : 'part') : (d < today ? 'part' : '');
            return <div key={i} className={'d ' + cls} title={r ? `${r.completion}%` : t.noReportDay}>{N(Number(d.slice(8)))}</div>;
          })}
        </div>
        <div className="legend">
          <span><span className="dot" style={{ background: 'var(--green)' }} />{N(100)}%</span>
          <span><span className="dot" style={{ background: '#f3c1bf' }} />{t.noReportDay} / &lt; {N(100)}%</span>
        </div>
      </div>
    </div>
  );
}

/* ================= HISTORY ================= */
export function HistoryView({ reports, t, N, lang, onOpenDate }) {
  const [open, setOpen] = useState('');
  const sorted = [...reports].sort((a, b) => (a.date < b.date ? 1 : -1));
  if (!sorted.length) return <div className="card">{t.noReports}</div>;
  return (
    <div className="card">
      {sorted.map((r) => (
        <div key={r.date}>
          <button type="button" className="histrow" onClick={() => setOpen(open === r.date ? '' : r.date)}>
            <span className={'pct' + (r.completion >= 100 ? ' full' : ' low')}>{N(r.completion)}%</span>
            <span style={{ flex: 1 }}>
              <b>{fmtDate(r.date, lang)}</b>
              <span className="small" style={{ display: 'block' }}>
                {t.bhajan} {fmtDur(r.data.bhajanMinutes, t, N)} · {t.dandvat} {N(r.data.dandvat || 0)}
                {!r.editable ? ' · 🔒' : ''}
              </span>
            </span>
            <span className="small">{open === r.date ? t.hideDetail : t.fullDetail}</span>
          </button>
          {open === r.date && (
            <div style={{ padding: '0 2px 12px' }}>
              <DetailGrid data={r.data} t={t} N={N} customDefs={r.custom} />
              <div style={{ marginTop: 10 }}>
                <button type="button" className="btn ghost small" onClick={() => onOpenDate(r.date)}>{t.view} →</button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ================= GROUPS ================= */
function MemberReportCard({ entry, t, N, lang }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <button type="button" className="histrow" onClick={() => setOpen(!open)}>
        <span className={'pct' + (entry.completion >= 100 ? ' full' : ' low')}>{N(entry.completion)}%</span>
        <span style={{ flex: 1 }}>
          <b>{entry.userName}</b>
          <span className="small" style={{ display: 'block' }}>{N(entry.completion)}% {t.percentDone} · {t.bhajan} {fmtDur(entry.data.bhajanMinutes, t, N)}</span>
        </span>
        <span className="small">{open ? t.hideDetail : t.fullDetail}</span>
      </button>
      {open && <DetailGrid data={entry.data} t={t} N={N} customDefs={entry.custom} />}
    </div>
  );
}

export function GroupsView({ token, user, t, N, lang }) {
  const [groups, setGroups] = useState([]);
  const [pendingMine, setPendingMine] = useState([]);
  const [sel, setSel] = useState(null); // group detail
  const [hits, setHits] = useState([]); // add-member search results
  const [gname, setGname] = useState('');
  const [code, setCode] = useState(() => {
    const s = store.get('dn-join-code') || '';
    return /^NIYAM-/i.test(s) ? s : ''; // token links join via the invitation page, not this box
  });
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const loadList = useCallback(async () => {
    try { const r = await api('listMyGroups', {}, token); setGroups(r.groups); setPendingMine(r.pendingRequests); } catch { /* */ }
  }, [token]);
  useEffect(() => { loadList(); }, [loadList]);

  const openGroup = async (id) => {
    setErr('');
    try { const r = await api('getGroupDetail', { groupId: id }, token); setSel(r); }
    catch (e) { if (e.code === 'not_member') setErr(t.errGeneric); }
  };
  useEffect(() => { if (sel) openGroup(sel.group.id); }, []); // eslint-disable-line

  const create = async () => {
    setErr(''); setMsg('');
    try { await api('createGroup', { name: gname }, token); setGname(''); loadList(); }
    catch { setErr(t.errGeneric); }
  };
  const join = async () => {
    setErr(''); setMsg('');
    // accept a pasted full link/message too — pull the code out of it
    const m = code.toUpperCase().match(/NIYAM-[A-Z0-9]+/);
    const finalCode = m ? m[0] : code.trim();
    try { await api('joinGroup', { code: finalCode }, token); setCode(''); store.del('dn-join-code'); setMsg(t.joinSent); loadList(); }
    catch (e) {
      setErr(e.code === 'invalid_code' ? t.joinErrCode : e.code === 'already_member' ? t.alreadyMember
        : e.code === 'already_requested' ? t.alreadyRequested : t.errGeneric);
    }
  };
  const act = async (action, args) => { try { await api(action, args, token); if (sel) openGroup(sel.group.id); loadList(); } catch { setErr(t.errGeneric); } };

  const inviteText = (g, link) => t.shareInvite
    .replaceAll('{name}', user?.name || '')
    .replaceAll('{group}', g.name)
    .replaceAll('{link}', link)
    .replaceAll('{code}', g.inviteCode);
  const copyInvite = async () => {
    if (!sel) return;
    try { await navigator.clipboard.writeText(sel.group.inviteCode); setMsg(t.codeCopied); } catch { setErr(t.errGeneric); }
  };
  const shareInvite = async () => {
    if (!sel) return;
    // Preferred: an opaque token link (the join code stays out of the URL).
    let link = `${window.location.origin}/join/${sel.group.inviteCode}?by=${user?.id || ''}`;
    try {
      const r = await api('createInviteLink', { groupId: sel.group.id }, token);
      if (r && r.token) link = `${window.location.origin}/join/${r.token}`;
    } catch { /* offline — fall back to the code link */ }
    const text = inviteText(sel.group, link);
    if (navigator.share) { try { await navigator.share({ text }); } catch { /* user closed the sheet */ } return; }
    try { await navigator.clipboard.writeText(text); setMsg(t.inviteCopied); } catch { setErr(t.errGeneric); }
  };

  if (sel) {
    const g = sel.group;
    const todayFeed = sel.feed[sel.feedDates[0]] || [];
    const memberIds = new Set(todayFeed.map((f) => f.userId));
    const todayMissing = sel.members.filter((m) => !memberIds.has(m.id));
    return (
      <div>
        <button type="button" className="linkbtn" onClick={() => { setSel(null); loadList(); }}>← {t.back}</button>
        <div className="card">
          <h2 className="sec" style={{ marginBottom: 2 }}>{g.name}</h2>
          <div className="small">{t.inviteCode}: <b style={{ letterSpacing: 1 }}>{g.inviteCode}</b></div>
          <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn ghost small" onClick={copyInvite}>📋 {t.copyBtn}</button>
            <button type="button" className="btn ghost small" onClick={shareInvite}>📤 {t.shareBtn}</button>
            {g.isGroupAdmin && (
              <button type="button" className="btn ghost small"
                onClick={async () => { const r = await api('resetInviteCode', { groupId: g.id }, token).catch(() => null); if (r) openGroup(g.id); }}>
                🔑 {t.resetCode}
              </button>
            )}
            {!g.isGroupAdmin && (
              <button type="button" className="btn ghost small" onClick={() => act('leaveGroup', { groupId: g.id }).then(() => setSel(null))}>{t.leave}</button>
            )}
          </div>
        </div>

        {g.isGroupAdmin && sel.requests.length > 0 && (
          <div className="card">
            <h3 className="sec">{t.requests} ({N(sel.requests.length)})</h3>
            {sel.requests.map((r) => (
              <div key={r.id} className="row">
                <div className="lab">{r.name}<small>{r.email}</small></div>
                <button type="button" className="btn small" onClick={() => act('approveJoinRequest', { requestId: r.id })}>{t.approve}</button>
                <button type="button" className="btn ghost small" onClick={() => act('rejectJoinRequest', { requestId: r.id })}>{t.reject}</button>
              </div>
            ))}
          </div>
        )}

        <h3 className="sec" style={{ margin: '14px 0 8px' }}>{t.todayInGroup} — {fmtDate(sel.feedDates[0], lang)}</h3>
        {todayFeed.map((f) => <MemberReportCard key={f.userId} entry={f} t={t} N={N} lang={lang} />)}
        {todayMissing.map((m) => (
          <div key={m.id} className="card" style={{ marginBottom: 10, opacity: .75 }}>
            <b>{m.name}</b> {m.id === user.id ? `(${t.youBadge})` : ''} — <span className="small">{t.noReportToday}</span>
          </div>
        ))}

        <h3 className="sec" style={{ margin: '16px 0 8px' }}>{t.last7}</h3>
        {sel.feedDates.slice(1).map((d) => (
          <div key={d} style={{ marginBottom: 8 }}>
            <div className="small" style={{ fontWeight: 700, marginBottom: 6 }}>{fmtDate(d, lang)}</div>
            {(sel.feed[d] || []).length === 0
              ? <div className="small">{t.noReportToday}</div>
              : (sel.feed[d] || []).map((f) => <MemberReportCard key={f.userId} entry={f} t={t} N={N} lang={lang} />)}
          </div>
        ))}

        {g.isGroupAdmin && (
          <div className="card">
            <h3 className="sec">{t.addMemberTitle}</h3>
            <input placeholder={t.searchUserPh} onChange={async (e) => {
              const q = e.target.value.trim();
              if (q.length < 2) { setHits([]); return; }
              try { const r = await api('searchUsers', { groupId: g.id, q }, token); setHits(r.users || []); } catch { /* offline */ }
            }} />
            {hits.map((h) => (
              <div key={h.id} className="row">
                <div className="lab">{h.name}<small>{h.email}</small></div>
                <button type="button" className="btn small" onClick={async () => {
                  try {
                    await api('addMemberDirect', { groupId: g.id, userId: h.id }, token);
                    setHits([]); setMsg(t.memberAdded); openGroup(g.id); load();
                  } catch (e2) { setErr(errText(e2, t)); }
                }}>{t.addBtn}</button>
              </div>
            ))}
          </div>
        )}

        <div className="card">
          <h3 className="sec">{t.members} ({N(sel.members.length)})</h3>
          {sel.members.map((m) => (
            <div key={m.id} className="row">
              <div className="lab">{m.name} {m.id === user.id ? `(${t.youBadge})` : ''}
                {m.role === 'owner' ? <> <span className="chip y">{t.roleOwner}</span></> : m.role === 'admin' ? <> <span className="chip y">{t.roleAdmin}</span></> : null}
                <small>{m.email}</small></div>
              {g.isGroupAdmin && m.id !== user.id && m.role !== 'owner' && (
                <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {m.role === 'member' && (
                    <button type="button" className="btn ghost small" onClick={() => act('setMemberRole', { groupId: g.id, userId: m.id, role: 'admin' })}>⭐ {t.makeAdmin}</button>
                  )}
                  {m.role === 'admin' && g.myRole === 'owner' && (
                    <button type="button" className="btn ghost small" onClick={() => act('setMemberRole', { groupId: g.id, userId: m.id, role: 'member' })}>{t.removeAdmin}</button>
                  )}
                  {(m.role === 'member' || g.myRole === 'owner') && (
                    <button type="button" className="btn ghost small" onClick={() => act('removeMember', { groupId: g.id, userId: m.id })}>{t.remove}</button>
                  )}
                </span>
              )}
            </div>
          ))}
        </div>
        {err ? <div className="err">{err}</div> : null}
      </div>
    );
  }

  return (
    <div>
      <h2 className="sec">{t.groupsTitle}</h2>
      {msg ? <div className="okmsg">{msg}</div> : null}
      {err ? <div className="err">{err}</div> : null}
      {groups.length === 0 && pendingMine.length === 0 && <div className="card">{t.noGroups}</div>}
      {groups.map((g) => (
        <button key={g.id} type="button" className="card" style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }} onClick={() => openGroup(g.id)}>
          <b style={{ fontSize: 17 }}>{g.name}</b>
          <span className="small" style={{ display: 'block' }}>
            {t.members}: {N(g.memberCount)} · {t.inviteCode}: {g.inviteCode}
            {g.incomingPending ? ` · ${t.requests}: ${N(g.incomingPending)}` : ''}
          </span>
        </button>
      ))}
      {pendingMine.map((p, i) => (
        <div key={i} className="card" style={{ opacity: .8 }}><b>{p.groupName}</b> — <span className="small">{t.pendingMine} ⏳</span></div>
      ))}
      <div className="grid2">
        <div className="card">
          <h3 className="sec">{t.createGroup}</h3>
          <input className="textin" value={gname} onChange={(e) => setGname(e.target.value)} placeholder={t.groupName} />
          <div style={{ marginTop: 10 }}><button type="button" className="btn" disabled={!gname.trim()} onClick={create}>{t.create}</button></div>
        </div>
        <div className="card">
          <h3 className="sec">{t.joinGroup}</h3>
          <input className="textin" value={code} onChange={(e) => setCode(e.target.value)} placeholder="NIYAM-XXXXXX" style={{ letterSpacing: 1 }} />
          <div style={{ marginTop: 10 }}><button type="button" className="btn" disabled={!code.trim()} onClick={join}>{t.joinBtn}</button></div>
        </div>
      </div>
    </div>
  );
}

/* ================= SETTINGS ================= */
export function SettingsView({ token, user, setUser, reportConfig, setReportConfig, loadReports, t, N, lang, setLang, theme, setTheme, settings, saveSettings, fireAlert, onLogout }) {
  const [perm, setPerm] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
  const [timeOpen, setTimeOpen] = useState(false);
  const [curPw, setCurPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [secMsg, setSecMsg] = useState('');
  const [secErr, setSecErr] = useState('');
  const [codes, setCodes] = useState(null); // remaining info
  const [newCodes, setNewCodes] = useState(null); // freshly regenerated, shown once
  const [regenPw, setRegenPw] = useState('');
  const [contactMsg, setContactMsg] = useState('');
  const [nameIn, setNameIn] = useState('');
  const [newField, setNewField] = useState('');
  const [newKind, setNewKind] = useState('toggle');
  const [itemsErr, setItemsErr] = useState('');
  const [profMsg, setProfMsg] = useState('');
  const [profErr, setProfErr] = useState('');
  const [delPw, setDelPw] = useState('');
  const [delMsg, setDelMsg] = useState('');
  const [delErr, setDelErr] = useState('');
  const [problemMsg, setProblemMsg] = useState('');
  const [helpMsg, setHelpMsg] = useState('');
  const [customInterval, setCustomInterval] = useState('');

  const loadCodes = useCallback(async () => {
    try { const r = await api('getBackupStatus', {}, token); setCodes(r); } catch { /* */ }
  }, [token]);
  useEffect(() => { loadCodes(); }, [loadCodes]);

  const toggleItem = async (key, on) => {
    setItemsErr('');
    const next = on ? reportConfig.hidden.filter((k) => k !== key) : [...reportConfig.hidden, key];
    try { const r = await api('setHiddenItems', { keys: next }, token); setReportConfig(r.config); if (loadReports) loadReports(); }
    catch (e) { setItemsErr(errText(e, t)); }
  };
  const addField = async () => {
    setItemsErr('');
    try { const r = await api('addCustomField', { label: newField.trim(), kind: newKind }, token); setReportConfig(r.config); setNewField(''); if (loadReports) loadReports(); }
    catch (e) { setItemsErr(errText(e, t)); }
  };
  const delField = async (id) => {
    setItemsErr('');
    try { const r = await api('deleteCustomField', { id }, token); setReportConfig(r.config); if (loadReports) loadReports(); }
    catch (e) { setItemsErr(errText(e, t)); }
  };
  const doChangeName = async () => {
    setProfErr(''); setProfMsg('');
    try {
      const r = await api('changeName', { name: nameIn.trim() }, token);
      setUser(r.user); setNameIn(''); setProfMsg(t.nameChanged);
    } catch (e) {
      if (e.code === 'name_cooldown' && user.nameChangedAt) {
        const days = Math.max(1, Math.ceil((user.nameChangedAt + 5 * 24 * 3600 * 1000 - Date.now()) / (24 * 3600 * 1000)));
        setProfErr(t.nameCooldownMsg.replace('{d}', N(days)));
      } else setProfErr(errText(e, t));
    }
  };
  const doRequestDeletion = async () => {
    setDelErr(''); setDelMsg('');
    try {
      const r = await api('requestAccountDeletion', { password: delPw }, token);
      setUser(r.user); setDelPw(''); setDelMsg(t.deletionRequested);
    } catch (e) { setDelErr(e.code === 'wrong_password' ? t.errInvalid : errText(e, t)); }
  };
  const doCancelDeletion = async () => {
    setDelErr(''); setDelMsg('');
    try {
      const r = await api('cancelAccountDeletion', {}, token);
      setUser(r.user); setDelMsg(t.deletionCancelled);
    } catch (e) { setDelErr(errText(e, t)); }
  };
  const changePw = async () => {
    setSecErr(''); setSecMsg('');
    try { await api('changePassword', { currentPassword: curPw, newPassword: newPw }, token); setSecMsg(t.savedOk); setCurPw(''); setNewPw(''); }
    catch (e) { setSecErr(e.code === 'wrong_password' ? t.errInvalid : errText(e, t)); }
  };
  const regen = async () => {
    setSecErr(''); setSecMsg('');
    try {
      const r = await api('regenerateBackupCodes', { currentPassword: regenPw }, token);
      setNewCodes(r.backupCodes); setRegenPw(''); loadCodes();
    } catch (e) { setSecErr(e.code === 'wrong_password' ? t.errInvalid : errText(e, t)); }
  };
  const sendHelp = async (type, message, clear) => {
    setHelpMsg('');
    try { await api('submitSupportMessage', { type, message }, token); clear(); setHelpMsg(t.sentOk); }
    catch { setHelpMsg(t.errGeneric); }
  };
  const requestPerm = async () => {
    try { const p = await Notification.requestPermission(); setPerm(p); } catch { /* */ }
  };
  const presetIntervals = [10, 15, 20, 30, 45, 60];
  const s = settings || { reminderEnabled: true, reminderTime: '21:00', smaranEnabled: false, smaranInterval: 30 };

  return (
    <div>
      <h2 className="sec">{t.settingsTitle}</h2>

      <div className="card">
        <h3 className="sec">🔔 {t.notifications}</h3>
        <div className="switchrow">
          <span><b>{t.reminder}</b> <span className="small">({s.reminderEnabled ? t.reminderOn : t.reminderOff})</span></span>
          <Switch checked={s.reminderEnabled} onChange={(v) => saveSettings({ ...s, reminderEnabled: v })} />
        </div>
        <div className="switchrow">
          <span><b>{t.reminderTime}</b></span>
          <button type="button" className="timebtn" onClick={() => setTimeOpen(true)}>
            {(() => { const o = hhmm24ToObj(s.reminderTime); return `${N(o.h)}:${N(pad(o.m))} ${o.ap}`; })()}
          </button>
        </div>
        {timeOpen && (
          <TimeWheelPopup t={t} N={N} value={hhmm24ToObj(s.reminderTime)} allowClear={false}
            onClose={() => setTimeOpen(false)}
            onDone={(o) => { setTimeOpen(false); if (o) saveSettings({ ...s, reminderTime: timeObjTo24(o) }); }} />
        )}
        <div className="switchrow">
          <span><b>{t.notifPermission}</b> <span className="small">{perm === 'granted' ? t.notifGranted : t.notifDefault}</span></span>
          {perm !== 'granted' && <button type="button" className="btn ghost small" onClick={requestPerm}>{t.enableNotif}</button>}
        </div>
        <div style={{ marginTop: 10 }}>
          <button type="button" className="btn ghost small" onClick={() => fireAlert('test')}>
            {t.testNotif}
          </button>
        </div>
        <div className="switchrow" style={{ marginTop: 6 }}>
          <span><b>🔔 {t.smaranBell}</b><span className="small" style={{ display: 'block' }}>{t.smaranDesc}</span></span>
          <Switch checked={s.smaranEnabled} onChange={(v) => saveSettings({ ...s, smaranEnabled: v })} />
        </div>
        <div className="row">
          <div className="lab">{t.interval}</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {presetIntervals.map((p) => (
              <button key={p} type="button" className={'pill' + (s.smaranInterval === p ? ' on' : '')}
                onClick={() => saveSettings({ ...s, smaranInterval: p })}>{N(p)}</button>
            ))}
            <input className="numin" style={{ width: 70 }} type="number" min={1} max={480} placeholder={t.custom}
              value={customInterval} onChange={(e) => setCustomInterval(e.target.value)}
              onBlur={() => { const v = Math.floor(Number(customInterval)); if (v >= 1 && v <= 480) saveSettings({ ...s, smaranInterval: v }); }} />
          </div>
        </div>
        <div style={{ marginTop: 8 }}>
          <button type="button" className="btn ghost small" onClick={() => fireAlert('bell')}>🔔 {t.testBell}</button>
        </div>
        <p className="small" style={{ marginTop: 12 }}>{t.closedAppNote}</p>
      </div>

      <div className="card">
        <h3 className="sec">{t.language} / {t.theme}</h3>
        <div className="switchrow"><span><b>{t.language}</b></span>
          <span style={{ display: 'flex', gap: 6 }}>
            <button type="button" className={'pill' + (lang === 'gu' ? ' on' : '')} onClick={() => setLang('gu')}>ગુજરાતી</button>
            <button type="button" className={'pill' + (lang === 'en' ? ' on' : '')} onClick={() => setLang('en')}>EN</button>
          </span>
        </div>
        <div className="switchrow"><span><b>{t.theme}</b></span>
          <span style={{ display: 'flex', gap: 6 }}>
            <button type="button" className={'pill' + (theme === 'light' ? ' on' : '')} onClick={() => setTheme('light')}>☀️ {t.themeLight}</button>
            <button type="button" className={'pill' + (theme === 'dark' ? ' on' : '')} onClick={() => setTheme('dark')}>🌙 {t.themeDark}</button>
          </span>
        </div>
      </div>

      <div className="card">
        <h3 className="sec">🪔 {t.reportItems}</h3>
        <p className="small">{t.reportItemsNote}</p>
        {itemsErr ? <div className="err">{itemsErr}</div> : null}
        {[['mangala', t.mangala], ['dhyan', t.dhyan], ['katha', t.katha], ['vachanamrut', t.vachanamrut],
          ['chesta', t.chesta], ['mandir', t.mandir], ['dandvat', t.dandvat], ['bhajan', t.bhajan],
          ['dhun', t.dhun], ['pradakshina', t.pradakshina], ['mansiPuja', t.mansiPuja], ['vvrat', t.vvrat]
        ].map(([key, label]) => (
          <div className="switchrow" key={key}><span>{label}</span>
            <input type="checkbox" checked={!reportConfig.hidden.includes(key)}
              onChange={(e) => toggleItem(key, e.target.checked)} />
          </div>
        ))}
        {(reportConfig.fields || []).map((f) => (
          <div className="row" key={f.key}>
            <div className="lab">{f.label}<small>{f.kind === 'count' ? t.kindCount : f.kind === 'duration' ? t.kindDuration : t.kindToggle}</small></div>
            <button type="button" className="btn ghost small" onClick={() => delField(f.id)}>✕</button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <input className="textin" style={{ flex: 1, minWidth: 160 }} placeholder={t.fieldNamePh} value={newField} onChange={(e) => setNewField(e.target.value)} />
          <select className="textin" value={newKind} onChange={(e) => setNewKind(e.target.value)}>
            <option value="toggle">{t.kindToggle}</option>
            <option value="count">{t.kindCount}</option>
            <option value="duration">{t.kindDuration}</option>
          </select>
          <button type="button" className="btn small" disabled={newField.trim().length < 2} onClick={addField}>{t.addFieldBtn}</button>
        </div>
      </div>

      <div className="card">
        <h3 className="sec">🔐 {t.security}</h3>
        {secErr ? <div className="err">{secErr}</div> : null}
        {secMsg ? <div className="okmsg">{secMsg}</div> : null}
        <div className="field" style={{ marginBottom: 8 }}>
          <label className="small" style={{ fontWeight: 700 }}>{t.changePassword}</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
            <input className="textin" style={{ flex: 1, minWidth: 150 }} type="password" placeholder={t.currentPassword} value={curPw} onChange={(e) => setCurPw(e.target.value)} />
            <input className="textin" style={{ flex: 1, minWidth: 150 }} type="password" placeholder={t.newPassword} value={newPw} onChange={(e) => setNewPw(e.target.value)} />
            <button type="button" className="btn small" disabled={!curPw || !newPw} onClick={changePw}>{t.changeBtn}</button>
          </div>
        </div>
        <div className="switchrow">
          <span><b>{t.backupCodes}</b> <span className="small">— {t.codesRemaining}: {codes ? `${N(codes.remaining)} / ${N(codes.total)}` : '…'}</span></span>
        </div>
        {newCodes ? (
          <div>
            <div className="codes">{newCodes.map((c) => <code key={c}>{c}</code>)}</div>
            <button type="button" className="btn ghost small" onClick={async () => { try { await navigator.clipboard.writeText(newCodes.join('\n')); } catch { /* */ } }}>{t.copyAll}</button>{' '}
            <button type="button" className="btn small" onClick={() => setNewCodes(null)}>{t.ok}</button>
          </div>
        ) : (
          <div style={{ marginTop: 8 }}>
            <div className="small">{t.regenWarn}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
              <input className="textin" style={{ flex: 1, minWidth: 150 }} type="password" placeholder={t.currentPassword} value={regenPw} onChange={(e) => setRegenPw(e.target.value)} />
              <button type="button" className="btn ghost small" disabled={!regenPw} onClick={regen}>{t.regenerate}</button>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h3 className="sec">✉️ {t.help}</h3>
        {helpMsg ? <div className="okmsg">{helpMsg}</div> : null}
        <label className="small" style={{ fontWeight: 700 }}>{t.contactDev}</label>
        <textarea className="textin" value={contactMsg} placeholder={t.messagePh} onChange={(e) => setContactMsg(e.target.value)} />
        <div style={{ margin: '8px 0 16px' }}>
          <button type="button" className="btn small" disabled={!contactMsg.trim()} onClick={() => sendHelp('contact', contactMsg, () => setContactMsg(''))}>{t.send}</button>
        </div>
        <label className="small" style={{ fontWeight: 700 }}>{t.reportProblem}</label>
        <textarea className="textin" value={problemMsg} placeholder={t.messagePh} onChange={(e) => setProblemMsg(e.target.value)} />
        <div style={{ marginTop: 8 }}>
          <button type="button" className="btn small" disabled={!problemMsg.trim()} onClick={() => sendHelp('problem', problemMsg, () => setProblemMsg(''))}>{t.send}</button>
        </div>
      </div>

      <div className="card">
        <h3 className="sec">{t.account}</h3>
        <div className="row"><div className="lab">{t.name}</div><b>{user.name}</b></div>
        <div className="row"><div className="lab">{t.email}</div><b>{user.email}</b></div>
        <div style={{ marginTop: 10 }}>
          <label className="small" style={{ fontWeight: 700 }}>{t.changeName}</label>
          {profErr ? <div className="err">{profErr}</div> : null}
          {profMsg ? <div className="okmsg">{profMsg}</div> : null}
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <input className="textin" style={{ flex: 1, minWidth: 150 }} placeholder={user.name} value={nameIn} onChange={(e) => setNameIn(e.target.value)} />
            <button type="button" className="btn small" disabled={!nameIn.trim()} onClick={doChangeName}>{t.changeBtn}</button>
          </div>
          <p className="small" style={{ marginTop: 6 }}>{t.nameRule}</p>
        </div>
        <div style={{ marginTop: 12 }}>
          <button type="button" className="btn danger" onClick={onLogout}>↪ {t.logout}</button>
        </div>
        <div style={{ borderTop: '1px solid var(--line)', marginTop: 16, paddingTop: 12 }}>
          <label className="small" style={{ fontWeight: 700, color: 'var(--red, #c0392b)' }}>⚠️ {t.deleteAccount}</label>
          {delErr ? <div className="err">{delErr}</div> : null}
          {delMsg ? <div className="okmsg">{delMsg}</div> : null}
          {user.deletionUntil ? (
            <div style={{ marginTop: 6 }}>
              <p className="small" style={{ fontWeight: 700 }}>
                {t.deletePending.replace('{date}', fmtDate(new Date(user.deletionUntil).toISOString().slice(0, 10), lang))}
              </p>
              <button type="button" className="btn ghost small" style={{ marginTop: 6 }} onClick={doCancelDeletion}>{t.cancelDeletion}</button>
            </div>
          ) : (
            <div style={{ marginTop: 6 }}>
              <p className="small">{t.deleteNote}</p>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <input className="textin" style={{ flex: 1, minWidth: 150 }} type="password" placeholder={t.currentPassword} value={delPw} onChange={(e) => setDelPw(e.target.value)} />
                <button type="button" className="btn danger small" disabled={!delPw} onClick={doRequestDeletion}>{t.deleteAccount}</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ================= ADMIN ================= */
function AdminUserReports({ token, userId, t, N, lang }) {
  const [reports, setReports] = useState(null);
  const [open, setOpen] = useState('');
  useEffect(() => {
    api('adminGetUserReports', { userId }, token).then((r) => setReports(r.reports)).catch(() => setReports([]));
  }, [token, userId]);
  if (!reports) return <div className="small">…</div>;
  if (!reports.length) return <div className="small">{t.noReports}</div>;
  return (
    <div>
      {reports.map((r) => (
        <div key={r.date}>
          <button type="button" className="histrow" onClick={() => setOpen(open === r.date ? '' : r.date)}>
            <span className={'pct' + (r.completion >= 100 ? ' full' : ' low')}>{N(r.completion)}%</span>
            <span style={{ flex: 1 }}><b>{fmtDate(r.date, lang)}</b></span>
            <span className="small">{open === r.date ? t.hideDetail : t.fullDetail}</span>
          </button>
          {open === r.date && <DetailGrid data={r.data} t={t} N={N} customDefs={r.custom} />}
        </div>
      ))}
    </div>
  );
}

export function AdminView({ token, t, N, lang, appStatus, refreshStatus }) {
  const [tab, setTab] = useState('users');
  const [users, setUsers] = useState([]);
  const [groups, setGroups] = useState([]);
  const [messages, setMessages] = useState([]);
  const [controls, setControls] = useState(null);
  const [openUser, setOpenUser] = useState(null);
  const [pwDraft, setPwDraft] = useState({});
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    try {
      const [u, g, m, c] = await Promise.all([
        api('adminListUsers', {}, token), api('adminListGroups', {}, token),
        api('adminListSupportMessages', {}, token), api('adminGetAppControls', {}, token),
      ]);
      setUsers(u.users); setGroups(g.groups); setMessages(m.messages); setControls(c.controls);
    } catch { /* forbidden etc. */ }
  }, [token]);
  useEffect(() => { load(); }, [load]);

  const setPw = async (uid) => {
    setMsg('');
    try { await api('adminSetUserPassword', { userId: uid, newPassword: pwDraft[uid] }, token); setMsg(t.savedOk); setPwDraft((d) => ({ ...d, [uid]: '' })); }
    catch (e) { setMsg(errText(e, t)); }
  };
  const saveControls = async () => {
    setMsg('');
    try { const r = await api('adminSetAppControls', controls, token); setControls(r.controls); setMsg(t.savedOk); if (refreshStatus) refreshStatus(); }
    catch { setMsg(t.errGeneric); }
  };
  const seedDemo = async () => {
    setMsg('');
    try {
      const r = await api('adminSeedDemo', {}, token);
      setMsg(`${t.demoFilled} (${N(r.added || 0)} ${t.reports}${r.skipped ? `, ${N(r.skipped)} ${t.demoSkipped}` : ''})`);
      load();
    } catch (e) { setMsg(errText(e, t)); }
  };
  const clearDemo = async () => {
    if (!window.confirm(t.demoConfirm)) return;
    setMsg('');
    try {
      const r = await api('adminClearDemo', {}, token);
      setMsg(`${t.demoCleared} (${N(r.removed || 0)} ${t.reports})`);
      load();
    } catch (e) { setMsg(errText(e, t)); }
  };
  const unread = messages.filter((m) => !m.readAt).length;

  return (
    <div>
      <h2 className="sec">👑 {t.adminTitle}</h2>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {[['users', t.users], ['inbox', `${t.inbox}${unread ? ` (${N(unread)})` : ''}`], ['groups', t.groupsW], ['controls', t.appControls]].map(([k, l]) => (
          <button key={k} type="button" className={'pill' + (tab === k ? ' on' : '')} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {msg ? <div className="okmsg">{msg}</div> : null}

      {tab === 'users' && (
        <div className="card overflowx">
          {users.length === 0 ? <div className="small">{t.noUsers}</div> : (
            <table className="users">
              <thead><tr><th>{t.name}</th><th>{t.email}</th><th>{t.joined}</th><th>{t.reports}</th><th>{t.groupsW}</th><th>{t.setPassword}</th></tr></thead>
              <tbody>
                {users.map((u) => (
                  <React.Fragment key={u.id}>
                    <tr>
                      <td><b>{u.name}</b>{u.isAdmin ? ' 👑' : ''}<br />
                        <button type="button" className="linkbtn" style={{ padding: 0 }} onClick={() => setOpenUser(openUser === u.id ? null : u.id)}>
                          {t.userReports.replace('’s reports', '')} {t.reports} →
                        </button></td>
                      <td>{u.email}</td>
                      <td>{fmtDate(isoLocal(new Date(u.createdAt)), lang)}</td>
                      <td>{N(u.reportCount)}</td><td>{N(u.groupCount)}</td>
                      <td>
                        <span style={{ display: 'flex', gap: 6 }}>
                          <input className="numin" style={{ width: 120, textAlign: 'left' }} type="password" placeholder={t.newPassword}
                            value={pwDraft[u.id] || ''} onChange={(e) => setPwDraft((d) => ({ ...d, [u.id]: e.target.value }))} />
                          <button type="button" className="btn ghost small" disabled={!(pwDraft[u.id] || '').length} onClick={() => setPw(u.id)}>{t.setBtn}</button>
                        </span>
                      </td>
                    </tr>
                    {openUser === u.id && (
                      <tr><td colSpan={6}><AdminUserReports token={token} userId={u.id} t={t} N={N} lang={lang} /></td></tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'inbox' && (
        <div className="card">
          {messages.length === 0 ? <div className="small">{t.noMessages}</div> : messages.map((m) => (
            <div key={m.id} className="row" style={{ alignItems: 'flex-start', opacity: m.readAt ? .65 : 1 }}>
              <div className="lab">
                <span className={'chip ' + (m.type === 'problem' ? 'r' : 'g')}>{m.type === 'problem' ? t.supportProblem : t.supportContact}</span>{' '}
                <b>{m.name}</b> <span className="small">({m.email}) · {new Date(m.createdAt).toLocaleString(lang === 'gu' ? 'gu-IN' : 'en-IN')}</span>
                <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{m.message}</div>
              </div>
              {!m.readAt && <button type="button" className="btn ghost small" onClick={async () => { await api('adminMarkSupportRead', { messageId: m.id }, token).catch(() => {}); load(); }}>{t.markRead}</button>}
            </div>
          ))}
        </div>
      )}

      {tab === 'groups' && (
        <div className="card">
          {groups.length === 0 ? <div className="small">{t.noGroups}</div> : groups.map((g) => (
            <div key={g.id} className="row">
              <div className="lab"><b>{g.name}</b><small>{t.adminBadge}: {g.adminName} ({g.adminEmail}) · {t.inviteCode}: {g.inviteCode}</small></div>
              <b>{t.members}: {N(g.memberCount)}</b>
            </div>
          ))}
        </div>
      )}

      {tab === 'controls' && controls && (
        <div className="card">
          <h3 className="sec">📣 {t.announcement}</h3>
          <textarea className="textin" value={controls.announcementText} placeholder={t.announcementText}
            onChange={(e) => setControls({ ...controls, announcementText: e.target.value })} />
          <div className="switchrow"><span><b>{t.showBanner}</b></span>
            <Switch checked={controls.announcementOn} onChange={(v) => setControls({ ...controls, announcementOn: v })} /></div>
          <div style={{ margin: '8px 0 16px' }}>
            <button type="button" className="btn ghost small" onClick={() => setControls({ ...controls, announcementText: '', announcementOn: false })}>{t.clearAnn}</button>
          </div>
          <h3 className="sec">🛠 {t.maintenance}</h3>
          <div className="switchrow"><span><b>{t.maintenance}</b></span>
            <Switch checked={controls.maintenanceOn} onChange={(v) => setControls({ ...controls, maintenanceOn: v })} /></div>
          <input className="textin" style={{ margin: '8px 0 16px' }} value={controls.maintenanceMsg} placeholder={t.maintenanceMsg}
            onChange={(e) => setControls({ ...controls, maintenanceMsg: e.target.value })} />
          <h3 className="sec">⬆️ {t.updateSection}</h3>
          <div className="row"><div className="lab">{t.latestVersion}</div>
            <input className="textin" style={{ maxWidth: 180 }} value={controls.latestVersion} placeholder="1.1.0"
              onChange={(e) => setControls({ ...controls, latestVersion: e.target.value })} /></div>
          <div className="row"><div className="lab">{t.updateNotes}</div>
            <input className="textin" style={{ maxWidth: 320 }} value={controls.updateNotes}
              onChange={(e) => setControls({ ...controls, updateNotes: e.target.value })} /></div>
          <div className="row"><div className="lab">{t.downloadUrl}</div>
            <input className="textin" style={{ maxWidth: 320 }} value={controls.downloadUrl} placeholder="https://…"
              onChange={(e) => setControls({ ...controls, downloadUrl: e.target.value })} /></div>
          <div className="switchrow"><span><b>{t.forceUpdate}</b></span>
            <Switch checked={controls.forceUpdate} onChange={(v) => setControls({ ...controls, forceUpdate: v })} /></div>
          <div style={{ marginTop: 14 }}>
            <button type="button" className="btn" onClick={saveControls}>{t.saveControls}</button>
          </div>
        </div>
      )}

      {tab === 'controls' && (
        <div className="card" style={{ marginTop: 14 }}>
          <h3 className="sec">{t.demoTitle}</h3>
          <div className="small" style={{ marginBottom: 12 }}>{t.demoNote}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn" onClick={seedDemo}>{t.demoFill}</button>
            <button type="button" className="btn ghost" onClick={clearDemo}>{t.demoClear}</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ================= ROOT APP ================= */
/* Big invitation page for /join/<code> links: who invited, the group, its
   admin and details, with the Join button at the bottom. */
export function InviteLanding({ t, lang, invite, user, token, onLogin, onClose, onDone }) {
  const [pv, setPv] = useState(null);
  const [state, setState] = useState('idle'); // idle|busy|sent|member|requested
  const [err, setErr] = useState('');
  const loc = lang === 'gu' ? 'gu-IN' : 'en-IN';

  useEffect(() => {
    const args = { code: invite.code };
    const byNum = Number(invite.by || 0);
    if (byNum > 0) args.by = byNum;
    api('groupPreview', args).then(setPv)
      .catch((e) => setErr(e.code === 'invalid_code' ? t.joinErrCode : t.errGeneric));
  }, []); // eslint-disable-line

  const join = async () => {
    setState('busy'); setErr('');
    try { await api('joinGroup', { code: invite.code }, token); setState('sent'); }
    catch (e) {
      if (e.code === 'already_member') setState('member');
      else if (e.code === 'already_requested') setState('requested');
      else { setState('idle'); setErr(e.code === 'invalid_code' ? t.joinErrCode : t.errGeneric); }
    }
  };

  const row = (label, value) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '7px 0' }}>
      <span style={{ color: 'var(--ink2)' }}>{label}</span>
      <b>{value}</b>
    </div>
  );

  return (
    <div className="authwrap">
      <div className="card authcard" style={{ textAlign: 'center' }}>
        <img className="logo" src={iconUrl} alt="Daily Niyam" />
        <h1 style={{ margin: '10px 0 0' }}>{t.appNameGu}</h1>
        <div style={{ marginTop: 6, fontSize: 17, fontWeight: 700, color: 'var(--accent2)' }}>🙏 {t.inviteHeading}</div>
        {pv ? (
          <>
            {pv.inviterName && (
              <p style={{ margin: '14px 0 2px', fontSize: 16.5, color: 'var(--ink2)' }}>
                {t.invitedBy.replace('{name}', pv.inviterName)}
              </p>
            )}
            <h2 style={{ margin: '4px 0 10px', fontSize: 31 }}>{pv.name}</h2>
            <div style={{ textAlign: 'left', borderTop: '1px solid var(--line)', marginTop: 6 }}>
              {pv.adminName ? row(t.adminBadge, pv.adminName) : null}
              {row(t.members, Number(pv.memberCount).toLocaleString(loc))}
              {pv.createdAt ? row(t.inviteStarted, new Date(pv.createdAt).toLocaleDateString(loc, { day: 'numeric', month: 'short', year: 'numeric' })) : null}
              {row(t.inviteCode, invite.code)}
            </div>
          </>
        ) : (
          !err && <p className="small" style={{ marginTop: 16 }}>…</p>
        )}
        {err && <p style={{ color: 'var(--red)', marginTop: 14 }}>{err}</p>}
        <div style={{ marginTop: 22 }}>
          {pv && state === 'sent' && (
            <>
              <div style={{ padding: '10px 12px', borderRadius: 12, background: 'var(--accent-soft, #FBE3C2)', fontWeight: 600, marginBottom: 12 }}>{t.joinSent}</div>
              <button type="button" className="btn" style={{ width: '100%' }} onClick={onDone}>{t.inviteViewGroups}</button>
            </>
          )}
          {pv && (state === 'member' || state === 'requested') && (
            <>
              <div style={{ padding: '10px 12px', borderRadius: 12, background: 'var(--accent-soft, #FBE3C2)', fontWeight: 600, marginBottom: 12 }}>
                {state === 'member' ? t.alreadyMember : t.alreadyRequested}
              </div>
              <button type="button" className="btn" style={{ width: '100%' }} onClick={onDone}>{t.inviteViewGroups}</button>
            </>
          )}
          {pv && state !== 'sent' && state !== 'member' && state !== 'requested' && (
            user ? (
              <>
                <button type="button" className="btn" style={{ width: '100%' }} disabled={state === 'busy'} onClick={join}>
                  {state === 'busy' ? '…' : t.joinBtn}
                </button>
                <div style={{ marginTop: 8 }}>
                  <button type="button" className="linkbtn" onClick={onClose}>{t.inviteSkip}</button>
                </div>
              </>
            ) : (
              <>
                <button type="button" className="btn" style={{ width: '100%' }} onClick={onLogin}>{t.inviteLoginBtn}</button>
                <div style={{ marginTop: 8 }}>
                  <button type="button" className="linkbtn" onClick={onClose}>{t.inviteSkip}</button>
                </div>
              </>
            )
          )}
          {!pv && err && (
            <button type="button" className="btn" style={{ width: '100%' }} onClick={onClose}>{t.inviteViewGroups}</button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [lang, setLang] = useState(() => store.get('dn-lang') || 'gu');
  const [theme, setTheme] = useState(() => store.get('dn-theme') || 'light');
  const t = lang === 'gu' ? gu : en;
  const N = (n) => num(n, lang);

  const [token, setToken] = useState(() => store.get('dn-token') || '');
  const [user, setUser] = useState(null);
  const [booted, setBooted] = useState(false);
  const [pendingCodes, setPendingCodes] = useState(null); // { token, user, codes }
  const [tab, setTab] = useState('report');
  const [date, setDate] = useState(isoLocal());
  const [reports, setReports] = useState([]);
  const [settings, setSettings] = useState(null);
  const [reportConfig, setReportConfig] = useState({ hidden: [], fields: [] });
  const [appStatus, setAppStatus] = useState(null);
  const [alertBox, setAlertBox] = useState(null); // { title, body }
  const [updDismissed, setUpdDismissed] = useState(() => store.sget('dn-upd-dismissed') || '');
  const [adminLoginOpen, setAdminLoginOpen] = useState(false);
  const [inviteView, setInviteView] = useState(() => {
    const c = store.get('dn-join-code');
    return c ? { code: c, by: store.get('dn-join-by') || '' } : null;
  });
  const [authForInvite, setAuthForInvite] = useState(false);
  const closeInvite = () => {
    setInviteView(null); setAuthForInvite(false);
    store.del('dn-join-code'); store.del('dn-join-by');
  };

  useEffect(() => { store.set('dn-lang', lang); document.documentElement.lang = lang === 'gu' ? 'gu' : 'en'; }, [lang]);
  useEffect(() => { store.set('dn-theme', theme); document.documentElement.dataset.theme = theme; }, [theme]);

  /* app status (announcement / maintenance / update) — no login needed, re-checked every minute */
  const refreshStatus = useCallback(async () => {
    try { const s = await api('getAppStatus', {}); setAppStatus(s); } catch { /* offline */ }
  }, []);
  useEffect(() => {
    refreshStatus();
    const id = setInterval(refreshStatus, 60000);
    return () => clearInterval(id);
  }, [refreshStatus]);

  /* invite link: /join/NIYAM-XXXXXX?by=<id> (or ?join=) — stash + open the invitation page */
  useEffect(() => {
    const m = window.location.pathname.match(/\/join\/([A-Za-z0-9_-]{6,})/)
      || window.location.search.match(/[?&]join=([A-Za-z0-9_-]{6,})/);
    if (m) {
      const code = /^NIYAM-/i.test(m[1]) ? m[1].toUpperCase() : m[1];
      const by = new URLSearchParams(window.location.search).get('by') || '';
      store.set('dn-join-code', code);
      if (by) store.set('dn-join-by', by);
      setInviteView({ code, by });
      window.history.replaceState({}, '', '/');
    }
  }, []);

  /* arriving via an invite link lands on the Groups tab once logged in */
  useEffect(() => { if (user && store.get('dn-join-code')) setTab('groups'); }, [user]);

  /* group events (join requests / approvals) → browser notifications
     while the site is open; the server marks them seen once delivered */
  useEffect(() => {
    if (!user || !token) return;
    let stop = false;
    const poll = async () => {
      try {
        const r = await api('pollEvents', {}, token);
        if (stop || !r.events) return;
        for (const e of r.events) {
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            const { title, body } = eventText(e, t);
            try { new Notification(title, { body, icon: iconUrl }); } catch { /* */ }
          }
        }
      } catch { /* offline */ }
    };
    poll();
    const id = setInterval(poll, 45000);
    return () => { stop = true; clearInterval(id); };
  }, [user, token]); // eslint-disable-line

  /* session boot */
  useEffect(() => {
    (async () => {
      if (token) {
        try { const r = await api('me', {}, token); setUser(r.user); }
        catch { store.del('dn-token'); setToken(''); }
      }
      setBooted(true);
    })();
  }, []); // eslint-disable-line

  const loadReports = useCallback(async () => {
    if (!token || !user) return;
    try { const r = await api('listReports', {}, token); setReports(r.reports); } catch { /* */ }
  }, [token, user]);
  useEffect(() => { loadReports(); }, [loadReports]);

  const loadSettings = useCallback(async () => {
    if (!token || !user) return;
    try { const r = await api('getUserSettings', {}, token); setSettings(r.settings); } catch { /* */ }
  }, [token, user]);
  useEffect(() => { loadSettings(); }, [loadSettings]);

  const loadReportConfig = useCallback(async () => {
    if (!token || !user) return;
    try { const r = await api('getReportConfig', {}, token); setReportConfig(r.config); } catch { /* */ }
  }, [token, user]);
  useEffect(() => { loadReportConfig(); }, [loadReportConfig]);

  const saveSettings = useCallback(async (next) => {
    setSettings(next);
    // smaran anchor: first ring comes one full interval after enabling / interval change
    if (next.smaranEnabled) {
      const prevRaw = store.get('dn-smaran-cfg');
      const cfg = `${next.smaranEnabled}|${next.smaranInterval}`;
      if (prevRaw !== cfg) { store.set('dn-smaran-cfg', cfg); store.set('dn-smaran-anchor', String(Date.now())); }
    } else store.del('dn-smaran-anchor');
    try { await api('setUserSettings', next, token); } catch { /* */ }
  }, [token]);

  /* in-app alert (banner + OS notification + sound + vibration) */
  const fireAlert = useCallback(async (kind) => {
    if (kind === 'bell') {
      playTempleBell(); vibrate([300, 100, 300, 100, 300]);
      osNotify(t.appName, t.bellNotifBody);
      setAlertBox({ title: '🔔 ' + t.smaranBell, body: t.bellNotifBody });
      return;
    }
    let submitted = false;
    if (kind !== 'test' && token) {
      try { const r = await api('getReport', { date: isoLocal() }, token); submitted = !!r.report; } catch { /* */ }
    }
    if (kind === 'test') submitted = false;
    const body = submitted ? t.remDoneBody : t.remFillBody;
    playChime(); vibrate([200, 100, 200]);
    osNotify(t.appName, body);
    setAlertBox({ title: '🔔 ' + t.reminder, body });
  }, [t, token]);

  /* nightly reminder watcher — fires while app is open, once per day, at/after chosen time */
  useEffect(() => {
    if (!user || !settings || !settings.reminderEnabled) return;
    const check = () => {
      const now = new Date();
      const [hh, mm] = String(settings.reminderTime || '21:00').split(':').map(Number);
      if (now.getHours() * 60 + now.getMinutes() < hh * 60 + mm) return;
      const key = 'dn-rem-fired-' + isoLocal();
      if (store.get(key) === '1') return;
      store.set(key, '1');
      fireAlert('reminder');
    };
    check();
    const id = setInterval(check, 30000);
    return () => clearInterval(id);
  }, [user, settings, fireAlert]);

  /* smaran bell watcher — every interval while app is open */
  useEffect(() => {
    if (!user || !settings || !settings.smaranEnabled) return;
    if (!store.get('dn-smaran-anchor')) store.set('dn-smaran-anchor', String(Date.now()));
    const id = setInterval(() => {
      const anchor = Number(store.get('dn-smaran-anchor') || Date.now());
      const intervalMs = (settings.smaranInterval || 30) * 60000;
      if (Date.now() - anchor >= intervalMs) {
        store.set('dn-smaran-anchor', String(Date.now()));
        fireAlert('bell');
      }
    }, 5000);
    return () => clearInterval(id);
  }, [user, settings, fireAlert]);

  const onAuthed = (r, isSignup) => {
    store.set('dn-token', r.token);
    setAuthForInvite(false); // back to the invitation page, if one is open
    if (isSignup && r.backupCodes) { setPendingCodes({ token: r.token, user: r.user, codes: r.backupCodes }); return; }
    setToken(r.token); setUser(r.user); setTab('report');
  };
  const finishCodes = () => {
    if (!pendingCodes) return;
    setToken(pendingCodes.token); setUser(pendingCodes.user); setPendingCodes(null); setTab('report');
    setAuthForInvite(false);
  };
  const onLogout = async () => {
    try { await api('logout', {}, token); } catch { /* */ }
    store.del('dn-token'); setToken(''); setUser(null); setReports([]); setSettings(null); setTab('report');
  };

  /* ----- gates & popups ----- */
  const maintenanceOn = !!(appStatus && appStatus.maintenance.on);
  const isAdmin = !!(user && user.isAdmin);
  const upd = appStatus && appStatus.update;
  const showUpdate = !!(upd && isNewerVersion(upd.latestVersion, APP_VERSION) && updDismissed !== upd.latestVersion);
  const forceUpd = !!(upd && upd.forceUpdate) && !isAdmin;

  if (!booted) return <div className="authwrap"><div className="bigpct">🙏</div></div>;

  if (pendingCodes) return <BackupCodesScreen codes={pendingCodes.codes} t={t} onDone={finishCodes} />;

  if (maintenanceOn && !isAdmin) {
    if (!user && adminLoginOpen) {
      return <AuthScreen t={t} lang={lang} setLang={setLang} theme={theme} setTheme={setTheme} onAuthed={onAuthed} />;
    }
    return (
      <div className="maint">
        <div>
          <img src={iconUrl} alt="" style={{ width: 84, height: 84, borderRadius: 20, boxShadow: 'var(--shadow)' }} />
          <h1>{t.maintTitle} 🛠</h1>
          <p style={{ maxWidth: 420 }}>{appStatus.maintenance.msg || t.maintDefault}</p>
          {!user && <button type="button" className="btn" onClick={() => setAdminLoginOpen(true)}>{t.adminLogin}</button>}
          {user && <button type="button" className="btn ghost" onClick={onLogout}>↪ {t.logout}</button>}
        </div>
      </div>
    );
  }

  if (inviteView && !authForInvite) {
    return <InviteLanding t={t} lang={lang} invite={inviteView} user={user} token={token}
      onLogin={() => setAuthForInvite(true)}
      onClose={closeInvite}
      onDone={() => { closeInvite(); setTab('groups'); }} />;
  }

  if (!user) {
    return <AuthScreen t={t} lang={lang} setLang={setLang} theme={theme} setTheme={setTheme} onAuthed={onAuthed} />;
  }

  const tabs = [
    ['report', '📝', t.tabReport], ['progress', '📈', t.tabProgress], ['history', '🕘', t.tabHistory],
    ['groups', '👥', t.tabGroups], ['settings', '⚙️', t.tabSettings],
    ...(isAdmin ? [['admin', '👑', t.tabAdmin]] : []),
  ];

  return (
    <div className="app">
      {appStatus && appStatus.announcement.on && appStatus.announcement.text ? (
        <div className="announce">📣 {appStatus.announcement.text}</div>
      ) : null}
      <header className="header">
        <div className="brand">
          <img src={iconUrl} alt="" />
          <span className="brandname">{lang === 'gu' ? t.appNameGu : t.appName}</span>
        </div>
        <div className="spacer" />
        <nav className="topnav">
          {tabs.map(([k, ic, l]) => (
            <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{ic} {l}</button>
          ))}
        </nav>
        <span className="uname">{user.name}</span>
      </header>

      <main className="main" key={tab}>
        {tab === 'report' && (
          <ReportForm token={token} t={t} N={N} lang={lang} date={date} setDate={setDate} onSaved={loadReports} reportConfig={reportConfig} />
        )}
        {tab === 'progress' && <ProgressView reports={reports} t={t} N={N} lang={lang} />}
        {tab === 'history' && (
          <HistoryView reports={reports} t={t} N={N} lang={lang}
            onOpenDate={(d) => { setDate(d); setTab('report'); }} />
        )}
        {tab === 'groups' && <GroupsView token={token} user={user} t={t} N={N} lang={lang} />}
        {tab === 'settings' && (
          <SettingsView token={token} user={user} setUser={setUser} reportConfig={reportConfig} setReportConfig={setReportConfig} loadReports={loadReports} t={t} N={N} lang={lang} setLang={setLang}
            theme={theme} setTheme={setTheme} settings={settings} saveSettings={saveSettings}
            fireAlert={fireAlert} onLogout={onLogout} />
        )}
        {tab === 'admin' && isAdmin && (
          <AdminView token={token} t={t} N={N} lang={lang} appStatus={appStatus} refreshStatus={refreshStatus} />
        )}
      </main>

      <nav className="bottomnav">
        {tabs.map(([k, ic, l]) => (
          <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            <span style={{ fontSize: 18 }}>{ic}</span>{l}
          </button>
        ))}
      </nav>

      {alertBox && (
        <div className="inappnotif">
          <b>{alertBox.title}</b>
          <div style={{ margin: '4px 0 8px' }}>{alertBox.body}</div>
          <button type="button" className="btn small" onClick={() => setAlertBox(null)}>{t.ok}</button>
        </div>
      )}

      {showUpdate && (
        <div className="overlay">
          <div className="modal" style={{ textAlign: 'center' }}>
            <img src={iconUrl} alt="" style={{ width: 64, height: 64, borderRadius: 16 }} />
            <h2 style={{ margin: '10px 0 4px' }}>{t.updateTitle}</h2>
            <div className="small">{t.latestVersion}: <b>{upd.latestVersion}</b> · {t.yourVersion}: {APP_VERSION}</div>
            {upd.notes ? <p style={{ whiteSpace: 'pre-wrap' }}>{upd.notes}</p> : null}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 12 }}>
              {(!forceUpd) && (
                <button type="button" className="btn ghost" onClick={() => { setUpdDismissed(upd.latestVersion); store.sset('dn-upd-dismissed', upd.latestVersion); }}>
                  {t.later}
                </button>
              )}
              <button type="button" className="btn" onClick={() => {
                if (upd.downloadUrl) window.open(upd.downloadUrl, '_blank');
                else window.location.reload();
              }}>{t.updateNow}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
