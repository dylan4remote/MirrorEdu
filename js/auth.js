(async function () {
  const supabase = await getSupabaseClient();

  // If already signed in, skip straight to the app.
  const { data: sessionData } = await supabase.auth.getSession();
  if (sessionData.session) {
    window.location.href = 'chat.html';
    return;
  }

  let mode = 'signin';
  const tabButtons = document.querySelectorAll('.tab-btn');
  const submitBtn = document.getElementById('submit-btn');
  const form = document.getElementById('auth-form');
  const errorBox = document.getElementById('error-box');

  function setMode(newMode) {
    mode = newMode;
    tabButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.mode === mode));
    submitBtn.textContent = mode === 'signin' ? 'Sign In' : 'Sign Up';
    hideError();
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.add('visible');
  }

  function hideError() {
    errorBox.classList.remove('visible');
  }

  tabButtons.forEach((btn) => btn.addEventListener('click', () => setMode(btn.dataset.mode)));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();
    submitBtn.disabled = true;

    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;

    try {
      if (mode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        window.location.href = 'chat.html';
      } else {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        showError('Check your email to confirm your account, then sign in.');
        setMode('signin');
      }
    } catch (err) {
      showError(err.message || 'Something went wrong.');
    } finally {
      submitBtn.disabled = false;
    }
  });
})();
