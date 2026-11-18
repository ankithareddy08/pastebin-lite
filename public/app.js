const form = document.querySelector('[data-paste-form]');

if (form) {
  const content = form.elements.content;
  const count = document.querySelector('[data-character-count]');
  const submit = document.querySelector('[data-submit-button]');
  const submitLabel = document.querySelector('[data-submit-label]');
  const error = document.querySelector('[data-form-error]');
  const success = document.querySelector('[data-success-panel]');
  const shareUrl = document.querySelector('#share-url');
  let submitting = false;

  content.addEventListener('input', () => {
    const length = Array.from(content.value).length;
    count.textContent = `${length.toLocaleString()} ${length === 1 ? 'character' : 'characters'}`;
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitting || !form.reportValidity()) return;

    error.hidden = true;
    success.hidden = true;
    const body = { content: content.value };
    for (const name of ['ttl_seconds', 'max_views']) {
      const value = form.elements[name].value;
      if (value !== '') {
        const number = Number(value);
        if (!Number.isSafeInteger(number) || number < 1) {
          error.textContent = 'Please use a positive whole number for each limit, or leave it blank.';
          error.hidden = false;
          form.elements[name].focus();
          return;
        }
        body[name] = number;
      }
    }

    submitting = true;
    submit.disabled = true;
    submitLabel.textContent = 'Creating…';
    form.setAttribute('aria-busy', 'true');

    try {
      const response = await fetch('/api/pastes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      let result;
      try {
        result = await response.json();
      } catch {
        throw new Error('The server returned an unexpected response. Please try again.');
      }
      if (!response.ok) {
        const message = typeof result.error === 'string' ? result.error : result.error?.message;
        throw new Error(message || 'Your paste could not be created. Please check your text and limits.');
      }
      const url = new URL(result.url);
      if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('The server returned an invalid share link. Please try again.');
      }
      shareUrl.value = url.href;
      document.querySelector('[data-open-paste]').href = url.href;
      document.querySelector('[data-copy-feedback]').textContent = '';
      success.hidden = false;
      success.focus({ preventScroll: true });
      success.scrollIntoView({ behavior: 'auto', block: 'nearest' });
    } catch (failure) {
      error.textContent = failure instanceof TypeError
        ? 'Could not connect to the server. Check your connection and try again. Your text is still here.'
        : failure.message || 'Something went wrong. Please try again.';
      error.hidden = false;
    } finally {
      submitting = false;
      submit.disabled = false;
      submitLabel.textContent = 'Create paste';
      form.removeAttribute('aria-busy');
    }
  });
}

for (const button of document.querySelectorAll('[data-copy-target]')) {
  button.addEventListener('click', async () => {
    const target = document.getElementById(button.dataset.copyTarget);
    const feedback = document.querySelector('[data-copy-feedback]');
    if (!target || !feedback) return;
    const text = 'value' in target ? target.value : target.textContent;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      feedback.textContent = 'Copied to clipboard.';
    } catch {
      if ('select' in target) {
        target.focus();
        target.select();
      } else {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(target);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      feedback.textContent = 'Text selected. Press Ctrl+C (or ⌘C) to copy.';
    }
  });
}
