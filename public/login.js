const form = document.getElementById('login-form');
const error = document.getElementById('login-error');
const password = document.getElementById('password');

document.getElementById('show-pw').addEventListener('click', (e) => {
  const show = password.type === 'password';
  password.type = show ? 'text' : 'password';
  e.currentTarget.textContent = show ? 'Hide' : 'Show';
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  error.textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: form.username.value, password: password.value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    location.replace('/');
  } catch (err) {
    error.textContent = err.message || 'Could not log in. Is the server running?';
    password.select();
  } finally {
    button.disabled = false;
  }
});
