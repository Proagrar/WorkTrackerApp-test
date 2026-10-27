import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const errorEl   = document.getElementById('loginError');
const successEl = document.getElementById('loginSuccess');
const loginBtn  = document.getElementById('loginBtn');
const btnLabel  = loginBtn.querySelector('.btn-label');

const emailField           = document.getElementById('emailField');
const passwordField        = document.getElementById('passwordField');
const confirmPasswordField = document.getElementById('confirmPasswordField');
const passwordLabel        = document.getElementById('passwordLabel');
const confirmPasswordLabel = document.getElementById('confirmPasswordLabel');
const toggleLink           = document.getElementById('authToggleLink');
const forgotLink           = document.getElementById('forgotPasswordLink');

// mode: 'login' | 'reset' | 'recovery'
// No self-signup — accounts are created by an admin in the app.
let mode = 'login';

function setMode(newMode) {
  mode = newMode;
  errorEl.hidden   = true;
  successEl.hidden = true;
  document.getElementById('loginForm').reset();

  emailField.hidden           = mode === 'recovery';
  passwordField.hidden        = mode === 'reset';
  confirmPasswordField.hidden = mode !== 'recovery';

  passwordLabel.textContent        = mode === 'recovery' ? 'Novo geslo'        : 'Geslo';
  confirmPasswordLabel.textContent = mode === 'recovery' ? 'Potrdi novo geslo' : 'Potrdi geslo';

  const labels = { login: 'Prijava', reset: 'Pošlji navodila', recovery: 'Nastavi geslo' };
  btnLabel.textContent = labels[mode];

  toggleLink.hidden = mode !== 'reset';

  forgotLink.hidden = mode !== 'login';
}

// If the URL itself says this is a password-recovery redirect, switch mode
// immediately — synchronously, before any async Supabase call resolves.
// Needed because the PASSWORD_RECOVERY event below and an already-restored
// session can settle in either order; relying on the event alone let a
// race send some users straight into the app before they ever saw the
// "set new password" screen, leaving them still not knowing their password.
if (window.location.hash.includes('type=recovery') || new URLSearchParams(window.location.search).get('type') === 'recovery') {
  setMode('recovery');
}

// Single source of truth for what happens on load after that: both
// INITIAL_SESSION (an existing/restored session) and PASSWORD_RECOVERY
// (user clicked a reset-password email link) come through this one
// listener, in order — nothing left to race between two independent
// async calls the way getSession() + a separate listener did.
supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'PASSWORD_RECOVERY') {
    setMode('recovery');
  } else if (event === 'INITIAL_SESSION' && session && mode !== 'recovery') {
    window.location.replace('app.html');
  }
});


toggleLink.addEventListener('click', () => setMode('login'));

forgotLink.addEventListener('click', () => setMode('reset'));

document.getElementById('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  errorEl.hidden   = true;
  successEl.hidden = true;

  // ── Reset: send recovery email ──────────────────────────────
  if (mode === 'reset') {
    const email = document.getElementById('email').value.trim();
    if (!email) return showError('Vnesite e-pošto.');
    setLoading(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + window.location.pathname,
    });
    setLoading(false);
    if (error) return showError(error.message);
    successEl.textContent = 'Preverite e-pošto za navodila za ponastavitev gesla.';
    successEl.hidden = false;
    return;
  }

  // ── Recovery: set new password ──────────────────────────────
  if (mode === 'recovery') {
    const password        = document.getElementById('password').value;
    const confirmPassword = document.getElementById('confirmPassword').value;
    if (password.length < 6)         return showError('Geslo mora imeti vsaj 6 znakov.');
    if (password !== confirmPassword) return showError('Gesli se ne ujemata.');
    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (error) return showError(error.message);
    successEl.textContent = 'Geslo je nastavljeno. Preusmerjanje...';
    successEl.hidden = false;
    setTimeout(() => window.location.replace('app.html'), 1500);
    return;
  }

  const email    = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  if (!email || !password) return showError('Vnesite e-pošto in geslo.');

  // ── Login ───────────────────────────────────────────────────
  setLoading(true);
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  setLoading(false);
  if (error) {
    showError(error.message === 'Invalid login credentials'
      ? 'Napačna e-pošta ali geslo.'
      : error.message);
    document.getElementById('password').value = '';
    return;
  }
  window.location.replace('app.html');
});

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
}

function setLoading(on) {
  loginBtn.disabled = on;
  btnLabel.hidden = on;
  loginBtn.querySelector('.btn-spinner').hidden = !on;
}
