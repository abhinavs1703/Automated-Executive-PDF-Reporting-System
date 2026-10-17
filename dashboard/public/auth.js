(() => {
  const $ = (id) => document.getElementById(id);
  const loginForm = $('login-form');
  const registerForm = $('register-form');
  const feedback = $('auth-feedback');
  const signupMode = window.location.pathname === '/signup';
  let googleEnabled = false;

  function setMode(register) {
    loginForm.classList.toggle('hidden', register);
    registerForm.classList.toggle('hidden', !register);
    $('auth-title').textContent = register ? 'Register your organisation' : 'Welcome back';
    $('auth-intro').textContent = register
      ? 'Create a private reporting workspace for your organisation. Your company data will stay separate from other workspaces.'
      : 'Sign in to open your organisation’s private reporting workspace.';
    $('auth-switch').innerHTML = register
      ? 'Already have an account? <a href="/login">Sign in</a>'
      : 'New to ExecuBrief? <a href="/signup">Create an account</a>';
    document.title = `${register ? 'Register organisation' : 'Sign in'} — ExecuBrief`;
    feedback.textContent = '';
  }

  function showFeedback(message, isSuccess = false) {
    feedback.textContent = message;
    feedback.classList.toggle('success', isSuccess);
  }

  async function submitAuth(form, endpoint) {
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = endpoint.endsWith('register') ? 'Creating account…' : 'Signing in…';
    showFeedback('');
    try {
      const data = Object.fromEntries(new FormData(form).entries());
      const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Sign-in failed. Please try again.');
      showFeedback(`Signed in as ${result.user?.email || 'your account'}${result.user?.organization?.name ? ` · ${result.user.organization.name}` : ''}. Opening your workspace…`, true);
      window.location.assign('/workspace');
    } catch (error) {
      showFeedback(error.message || 'Sign-in failed. Please try again.');
    } finally {
      button.disabled = false;
      button.textContent = endpoint.endsWith('register') ? 'Register organisation' : 'Sign in';
    }
  }

  loginForm.addEventListener('submit', (event) => {
    event.preventDefault();
    submitAuth(loginForm, '/api/auth/login');
  });
  registerForm.addEventListener('submit', (event) => {
    event.preventDefault();
    submitAuth(registerForm, '/api/auth/register');
  });

  setMode(signupMode);
  const errorCode = new URLSearchParams(window.location.search).get('error');
  if (errorCode === 'google') showFeedback('Google sign-in could not be completed. Please try again or use email and password.');
  if (errorCode === 'google-not-configured') showFeedback('Google sign-in is not configured yet. Use email and password or finish the Google OAuth setup.');
  if (errorCode === 'google-unverified') showFeedback('Google did not verify the email address for this account.');
  if (errorCode === 'google-state') showFeedback('Google sign-in expired or failed its security check. Please try again.');

  fetch('/api/auth/config', { credentials: 'same-origin' })
    .then((response) => response.json())
    .then((config) => {
      googleEnabled = Boolean(config.googleEnabled);
      $('google-signin').classList.toggle('hidden', !googleEnabled);
      $('google-unavailable').classList.toggle('hidden', googleEnabled);
    })
    .catch(() => {
      $('google-signin').classList.add('hidden');
      $('google-unavailable').classList.remove('hidden');
    });
})();
