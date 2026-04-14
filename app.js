// ── Storage (localStorage instead of electron-store) ──────────────────────────
const DEFAULTS = {
  settings: {
    workDuration: 25,
    shortBreakDuration: 5,
    longBreakDuration: 15,
    pomodorosBeforeLongBreak: 4,
    volume: 0.7
  },
  stats: {
    totalPomodoros: 0,
    totalFocusMinutes: 0,
    history: []
  }
}

function load(key) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? { ...DEFAULTS[key], ...JSON.parse(raw) } : DEFAULTS[key]
  } catch { return DEFAULTS[key] }
}

function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch {}
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id)
const elTimerText     = $('timer-text')
const elRingProgress  = $('ring-progress')
const elPhaseLabel    = $('phase-label')
const elPhaseDots     = $('phase-dots').querySelectorAll('.phase-dot')
const elBtnStartPause = $('btn-start-pause')
const elBtnReset      = $('btn-reset')
const elBtnSkip       = $('btn-skip')
const elStatToday     = $('stat-today')
const elStatTotal     = $('stat-total')
const elStatFocus     = $('stat-focus')
const elNotifBanner   = $('notif-banner')
const elAppTitle      = $('app-title')
const elVolume        = $('volume-slider')
const elBtnSave       = $('btn-save-settings')

const RING_CIRCUMFERENCE = 339.3

// ── State ─────────────────────────────────────────────────────────────────────
let settings = load('settings')
let stats    = load('stats')

let timer = {
  phase: 'idle',
  status: 'stopped',
  timeLeft: 0,
  totalTime: 0,
  pomodoroCount: 0,
  sessionStart: null
}

let intervalId  = null
let lastTick    = null
let audioCtx    = null

// ── Audio ─────────────────────────────────────────────────────────────────────
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)()
  return audioCtx
}

function playTone(freq, duration, vol = settings.volume) {
  const ctx  = getAudioCtx()
  const osc  = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.type = 'sine'
  osc.frequency.setValueAtTime(freq, ctx.currentTime)
  gain.gain.setValueAtTime(0, ctx.currentTime)
  gain.gain.linearRampToValueAtTime(vol, ctx.currentTime + 0.01)
  gain.gain.linearRampToValueAtTime(vol * 0.6, ctx.currentTime + 0.08)
  gain.gain.linearRampToValueAtTime(0, ctx.currentTime + duration)
  osc.start(ctx.currentTime)
  osc.stop(ctx.currentTime + duration + 0.05)
}

function playWorkComplete() {
  playTone(523.25, 0.3)
  setTimeout(() => playTone(659.25, 0.3), 200)
  setTimeout(() => playTone(783.99, 0.6), 400)
}

function playBreakComplete() {
  playTone(783.99, 0.3)
  setTimeout(() => playTone(659.25, 0.3), 200)
  setTimeout(() => playTone(523.25, 0.6), 400)
}

// ── Notifications ─────────────────────────────────────────────────────────────
function requestNotifPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission()
  }
}

function sendNotification(title, body) {
  // In-app banner (always shown)
  showBanner(title)
  // System notification (when tab is in background)
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body, icon: 'icons/icon.svg', silent: true })
  }
}

// ── Timer core ────────────────────────────────────────────────────────────────
function startTick() {
  lastTick = Date.now()
  intervalId = setInterval(() => {
    const now     = Date.now()
    const elapsed = Math.round((now - lastTick) / 1000)
    lastTick = now
    timer.timeLeft = Math.max(0, timer.timeLeft - elapsed)
    updateDisplay()
    if (timer.timeLeft === 0) handleSessionEnd()
  }, 1000)
}

function stopTick() {
  clearInterval(intervalId)
  intervalId = null
}

function startTimer() {
  if (timer.phase === 'idle') {
    timer.phase     = 'work'
    timer.totalTime = settings.workDuration * 60
    timer.timeLeft  = timer.totalTime
  }
  timer.status       = 'running'
  timer.sessionStart = Date.now()
  requestNotifPermission()
  startTick()
  updateDisplay()
}

function pauseTimer() {
  timer.status = 'paused'
  stopTick()
  updateDisplay()
}

function resetTimer() {
  stopTick()
  timer.phase        = 'idle'
  timer.status       = 'stopped'
  timer.timeLeft     = 0
  timer.totalTime    = settings.workDuration * 60
  timer.pomodoroCount = 0
  timer.sessionStart = null
  updateDisplay()
}

function skipPhase() {
  stopTick()
  if (timer.phase === 'work' && timer.sessionStart) {
    const elapsed = Math.round((Date.now() - timer.sessionStart) / 1000 / 60)
    if (elapsed > 0) recordSession('work', elapsed, false)
  }
  advancePhase()
}

function handleSessionEnd() {
  stopTick()
  if (timer.phase === 'work') {
    timer.pomodoroCount++
    recordSession('work', settings.workDuration, true)
    playWorkComplete()
    const isLong = timer.pomodoroCount % settings.pomodorosBeforeLongBreak === 0
    timer.phase     = isLong ? 'long' : 'short'
    timer.totalTime = (isLong ? settings.longBreakDuration : settings.shortBreakDuration) * 60
    sendNotification('Work session complete!', isLong ? 'Time for a long break.' : 'Time for a short break.')
  } else {
    playBreakComplete()
    timer.phase     = 'work'
    timer.totalTime = settings.workDuration * 60
    sendNotification('Break over!', 'Time to focus.')
  }
  timer.timeLeft     = timer.totalTime
  timer.status       = 'running'
  timer.sessionStart = Date.now()
  startTick()
  updateDisplay()
}

function advancePhase() {
  if (timer.phase === 'work' || timer.phase === 'idle') {
    const isLong = (timer.pomodoroCount % settings.pomodorosBeforeLongBreak === 0) && timer.pomodoroCount > 0
    timer.phase     = isLong ? 'long' : 'short'
    timer.totalTime = (isLong ? settings.longBreakDuration : settings.shortBreakDuration) * 60
  } else {
    timer.phase     = 'work'
    timer.totalTime = settings.workDuration * 60
  }
  timer.timeLeft     = timer.totalTime
  timer.status       = 'running'
  timer.sessionStart = Date.now()
  startTick()
  updateDisplay()
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function recordSession(type, duration, completed) {
  const entry = {
    date: new Date().toISOString().slice(0, 10),
    timestamp: Date.now(),
    type, duration, completed
  }
  stats.history.push(entry)
  if (stats.history.length > 500) stats.history.shift()
  if (type === 'work' && completed) {
    stats.totalPomodoros++
    stats.totalFocusMinutes += duration
  }
  save('stats', stats)
  updateStatsBar()
  renderStatsPanel()
}

function todayStr() { return new Date().toISOString().slice(0, 10) }

function updateStatsBar() {
  const today      = todayStr()
  const todayCount = stats.history.filter(e => e.date === today && e.type === 'work' && e.completed).length
  elStatToday.textContent = todayCount
  elStatTotal.textContent = stats.totalPomodoros
  const m = stats.totalFocusMinutes
  elStatFocus.textContent = m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? (m % 60) + 'm' : ''}` : `${m}m`
}

function renderStatsPanel() {
  const panel = $('panel-stats')
  const today = todayStr()
  const last7 = Array.from({ length: 7 }, (_, i) => {
    const d = new Date()
    d.setDate(d.getDate() - (6 - i))
    return d.toISOString().slice(0, 10)
  })

  const byDate = {}
  stats.history.filter(e => e.type === 'work' && e.completed)
    .forEach(e => { byDate[e.date] = (byDate[e.date] || 0) + 1 })

  const maxCount = Math.max(...last7.map(d => byDate[d] || 0), 1)

  const bars = last7.map(date => {
    const count  = byDate[date] || 0
    const height = Math.max(Math.round((count / maxCount) * 60), count > 0 ? 4 : 2)
    return `
      <div class="chart-bar-wrap ${date === today ? 'today' : ''}">
        <span class="bar-count">${count > 0 ? count : ''}</span>
        <div class="chart-bar" style="height:${height}px"></div>
        <span class="bar-label">${date.slice(5).replace('-', '/')}</span>
      </div>`
  }).join('')

  const h = Math.floor(stats.totalFocusMinutes / 60)
  const m = stats.totalFocusMinutes % 60

  panel.innerHTML = `
    <div class="stats-chart">${bars}</div>
    <div class="stats-totals">
      <div><span>Total sessions</span><strong>${stats.totalPomodoros}</strong></div>
      <div><span>Total focus time</span><strong>${h > 0 ? h + 'h ' : ''}${m}m</strong></div>
    </div>`
}

// ── Display ───────────────────────────────────────────────────────────────────
const PHASE_LABELS  = { idle: 'Ready', work: 'Focus', short: 'Short Break', long: 'Long Break' }
const PHASE_CLASSES = { idle: 'phase-idle', work: 'phase-work', short: 'phase-short', long: 'phase-long' }

function formatTime(secs) {
  return `${Math.floor(secs / 60).toString().padStart(2, '0')}:${(secs % 60).toString().padStart(2, '0')}`
}

function updateDisplay() {
  const displayTime = timer.phase === 'idle'
    ? formatTime(settings.workDuration * 60)
    : formatTime(timer.timeLeft)

  elTimerText.textContent = displayTime

  // Update browser tab title with timer so it's visible when app is backgrounded
  document.title = timer.status === 'running'
    ? `${displayTime} · ${PHASE_LABELS[timer.phase]}`
    : 'Pomodoro Timer'

  // Ring progress
  const total    = timer.totalTime || settings.workDuration * 60
  const progress = timer.phase === 'idle' ? 0 : (1 - timer.timeLeft / total)
  elRingProgress.style.strokeDashoffset = RING_CIRCUMFERENCE * (1 - progress)

  // Phase label, body class, header title
  elPhaseLabel.textContent = PHASE_LABELS[timer.phase] || 'Ready'
  elAppTitle.textContent   = timer.phase === 'idle' ? 'Pomodoro' : PHASE_LABELS[timer.phase]
  document.body.className  = PHASE_CLASSES[timer.phase] || 'phase-idle'

  // Start/Pause button
  elBtnStartPause.textContent =
    timer.status === 'running' ? 'Pause' :
    timer.status === 'paused'  ? 'Resume' : 'Start'

  // Session dots
  const max          = settings.pomodorosBeforeLongBreak
  const cycleCompleted = timer.pomodoroCount % max
  elPhaseDots.forEach((dot, i) => {
    dot.style.display = i < max ? 'block' : 'none'
    dot.classList.toggle('filled', i < cycleCompleted)
  })
}

// ── Banner ────────────────────────────────────────────────────────────────────
let bannerTimeout = null
function showBanner(msg) {
  elNotifBanner.textContent = msg
  elNotifBanner.classList.add('show')
  clearTimeout(bannerTimeout)
  bannerTimeout = setTimeout(() => elNotifBanner.classList.remove('show'), 3000)
}

// ── Settings ──────────────────────────────────────────────────────────────────
function renderSettingsValues() {
  ['workDuration', 'shortBreakDuration', 'longBreakDuration', 'pomodorosBeforeLongBreak'].forEach(k => {
    const el = $(`val-${k}`)
    if (el) el.value = settings[k]
  })
  elVolume.value = settings.volume
}

function saveSettings() {
  save('settings', settings)
  if (timer.status === 'stopped') {
    timer.totalTime = settings.workDuration * 60
    updateDisplay()
  }
  showBanner('Settings saved')
}

// ── Event listeners ───────────────────────────────────────────────────────────
elBtnStartPause.addEventListener('click', () => {
  getAudioCtx()
  if (timer.status === 'running') pauseTimer()
  else startTimer()
})

elBtnReset.addEventListener('click', resetTimer)
elBtnSkip.addEventListener('click', skipPhase)

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'))
    btn.classList.add('active')
    $(`panel-${btn.dataset.tab}`).classList.add('active')
    if (btn.dataset.tab === 'stats') renderStatsPanel()
  })
})

document.querySelectorAll('.btn-adj').forEach(btn => {
  btn.addEventListener('click', () => {
    const key   = btn.dataset.target
    const delta = parseInt(btn.dataset.delta, 10)
    const limits = { workDuration: [1, 120], shortBreakDuration: [1, 60], longBreakDuration: [1, 60], pomodorosBeforeLongBreak: [1, 8] }
    const [min, max] = limits[key] || [1, 99]
    settings[key] = Math.min(max, Math.max(min, settings[key] + delta))
    renderSettingsValues()
    if (key === 'pomodorosBeforeLongBreak') updateDisplay()
  })
})

const SETTING_LIMITS = { workDuration: [1, 120], shortBreakDuration: [1, 60], longBreakDuration: [1, 60], pomodorosBeforeLongBreak: [1, 8] }
Object.entries(SETTING_LIMITS).forEach(([key, [min, max]]) => {
  const el = $(`val-${key}`)
  if (!el) return
  el.addEventListener('change', () => {
    const val   = Math.min(max, Math.max(min, parseInt(el.value, 10) || min))
    settings[key] = val
    el.value = val
    if (key === 'pomodorosBeforeLongBreak') updateDisplay()
  })
})

elVolume.addEventListener('input', () => { settings.volume = parseFloat(elVolume.value) })
elBtnSave.addEventListener('click', saveSettings)

// Handle tab becoming visible again — recalculate elapsed time to stay accurate
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && timer.status === 'running') {
    lastTick = Date.now()
  }
})

// ── Service worker ────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {})
}

// ── Init ──────────────────────────────────────────────────────────────────────
settings = load('settings')
stats    = load('stats')
timer.totalTime = settings.workDuration * 60

renderSettingsValues()
updateDisplay()
updateStatsBar()
renderStatsPanel()
