/**
 * landing.js — Landing Page Auth Flow
 *
 * Ariadne — STFC Fleet Intelligence System
 * Extracted from landing.html for CSP compliance (script-src 'self').
 */

// ── Section switching ────────────────────
const sections = ['hero', 'features', 'signup', 'login', 'forgot', 'verify'];

function showSection(target) {
    // Show/hide auth forms
    sections.forEach(s => {
        const el = document.getElementById(`${s}-section`);
        if (!el) return;
        if (s === 'hero' || s === 'features') {
            // Hero and features are always visible unless an auth form is shown
            if (['signup', 'login', 'forgot', 'verify'].includes(target)) {
                el.style.display = 'none';
            } else {
                el.style.display = '';
            }
        } else {
            el.classList.toggle('active', s === target);
        }
    });
    // Clear messages
    document.querySelectorAll('.form-message').forEach(m => { m.className = 'form-message'; m.textContent = ''; });
}

function showMessage(formId, text, type) {
    const el = document.getElementById(`${formId}-message`);
    if (el) {
        el.textContent = text;
        el.className = `form-message ${type}`;
    }
}

// ── Sign Up ──────────────────────────────
async function handleSignup(e) {
    e.preventDefault();
    const btn = document.getElementById('signup-submit');
    btn.disabled = true;
    btn.textContent = 'Creating…';

    try {
        const resp = await fetch('/api/auth/signup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'majel-client' },
            body: JSON.stringify({
                email: document.getElementById('signup-email').value.trim(),
                password: document.getElementById('signup-password').value,
                displayName: document.getElementById('signup-name').value.trim(),
            }),
        });
        const data = await resp.json();

        if (data.ok) {
            // Store the resend nonce for the verification resend flow
            if (data.data?.resendToken) lastResendToken = data.data.resendToken;
            showSection('verify');
        } else {
            showMessage('signup', data.error?.message || 'Sign-up failed', 'error');
        }
    } catch {
        showMessage('signup', 'Network error. Please try again.', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Create Account';
    }
}

// ── Sign In ──────────────────────────────
async function handleLogin(e) {
    e.preventDefault();
    const btn = document.getElementById('login-submit');
    btn.disabled = true;
    btn.textContent = 'Signing in…';

    try {
        const resp = await fetch('/api/auth/signin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'majel-client' },
            body: JSON.stringify({
                email: document.getElementById('login-email').value.trim(),
                password: document.getElementById('login-password').value,
            }),
        });
        const data = await resp.json();

        if (data.ok) {
            // Redirect to app
            window.location.href = '/app';
        } else {
            showMessage('login', data.error?.message || 'Sign-in failed', 'error');
        }
    } catch {
        showMessage('login', 'Network error. Please try again.', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Sign In';
    }
}

// ── Forgot Password ─────────────────────
async function handleForgot(e) {
    e.preventDefault();
    try {
        await fetch('/api/auth/forgot-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'majel-client' },
            body: JSON.stringify({
                email: document.getElementById('forgot-email').value.trim(),
            }),
        });
        showMessage('forgot', 'If that email is registered, a reset link has been sent.', 'success');
    } catch {
        showMessage('forgot', 'Network error. Please try again.', 'error');
    }
}

// ── Wire up forms ────────────────────────
document.getElementById('signup-form')?.addEventListener('submit', handleSignup);
document.getElementById('login-form')?.addEventListener('submit', handleLogin);
document.getElementById('forgot-form')?.addEventListener('submit', handleForgot);

// ── Resend verification ──────────────────
let lastResendToken = '';

document.getElementById('resend-verify-link')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const link = e.currentTarget;
    if (!lastResendToken) {
        showMessage('resend', 'Please sign up first.', 'error');
        return;
    }
    link.textContent = 'Sending…';
    link.style.pointerEvents = 'none';
    try {
        const resp = await fetch('/api/auth/resend-verification', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'majel-client' },
            body: JSON.stringify({ resendToken: lastResendToken }),
        });
        const data = await resp.json();
        if (data.ok) {
            // Server issues a fresh nonce for subsequent resends
            if (data.data?.resendToken) lastResendToken = data.data.resendToken;
            showMessage('resend', 'Verification email resent — check your inbox.', 'success');
        } else {
            showMessage('resend', data.error?.message || 'Failed to resend.', 'error');
        }
    } catch {
        showMessage('resend', 'Network error. Please try again.', 'error');
    } finally {
        link.textContent = 'resend the verification email';
        link.style.pointerEvents = '';
    }
});

// ── Wire up navigation links ─────────────
document.querySelectorAll('[data-nav]').forEach(el => {
    el.addEventListener('click', (e) => {
        e.preventDefault();
        showSection(el.dataset.nav);
    });
});

// ── Auto-detect verify token in URL ─────
(function () {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    const page = window.location.pathname;

    if (page === '/verify' && token) {
        fetch('/api/auth/verify-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'majel-client' },
            body: JSON.stringify({ token }),
        })
            .then(r => r.json())
            .then(data => {
                if (data.ok) {
                    showSection('login');
                    showMessage('login', 'Email verified! You can now sign in.', 'success');
                } else {
                    showSection('login');
                    showMessage('login', 'Verification failed — link may be expired. Try signing up again.', 'error');
                }
            })
            .catch(() => {
                showSection('login');
                showMessage('login', 'Verification failed. Please try again.', 'error');
            });
    } else if (page === '/login') {
        showSection('login');
    } else if (page === '/signup') {
        showSection('signup');
    }

    // Check if user is already authenticated → redirect to app
    fetch('/api/auth/me')
        .then(r => r.json())
        .then(data => {
            if (data.ok && data.data?.user?.id) {
                window.location.href = '/app';
            }
        })
        .catch(() => { });
})();
