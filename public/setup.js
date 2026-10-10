const form = document.getElementById('setup-form');
const error = document.getElementById('login-error');

fetch('/api/auth-state').then((r) => r.json()).then((s) => {
  if (!s.needsSetup) location.replace('/login');
  else if (!s.homeNetwork) error.textContent = 'For safety, the first account can only be created from your home network (Wi-Fi), not over the internet.';
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.textContent = '';
  if (form.password.value !== form.password2.value) {
    error.textContent = 'The two passwords are different.';
    return;
  }
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const res = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: form.username.value, password: form.password.value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    location.replace('/');
  } catch (err) {
    error.textContent = err.message || 'Could not create the account.';
  } finally {
    button.disabled = false;
  }
});
