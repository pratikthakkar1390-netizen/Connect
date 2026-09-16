import { esc } from '../admin/html.js';
import { renderConnectLayout } from './rsvpPage.js';

const PAGE_CSS = `
<style>
.photo-preview {
  width: 100%;
  max-height: 18rem;
  object-fit: cover;
  border-radius: 0.9rem;
  margin: 0.75rem 0 1rem;
  display: none;
  background: var(--paper);
}
.photo-preview.show { display: block; }
.file-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  overflow: hidden;
}
.note { color: var(--muted); text-align: center; }
.error { color: var(--no); text-align: center; font-weight: 600; }
.choices { margin-top: 0.85rem; }
</style>`;

export function renderEventImagePage(options: {
  eventName?: string | null;
  previewSrc?: string | null;
  error?: string;
  mode?: 'create' | 'edit';
}): string {
  const editing = options.mode === 'edit';
  const heading = options.eventName?.trim()
    ? editing
      ? `Photo for ${options.eventName.trim()}`
      : `Add a photo for ${options.eventName.trim()}`
    : 'Event Image';
  const preview = options.previewSrc
    ? `<img class="photo-preview show" id="preview" alt="Selected event image" src="${esc(options.previewSrc)}">`
    : `<img class="photo-preview" id="preview" alt="Selected event image">`;
  const skipOrKeep = editing
    ? `<button class="btn" type="submit" name="action" value="keep">Keep current</button>
          <button class="btn" type="submit" name="action" value="remove">Remove photo</button>`
    : `<button class="btn" type="submit" name="action" value="skip">⏭️ Skip</button>`;

  return renderConnectLayout(
    'Event Image — CONNECT',
    `${PAGE_CSS}
    <section class="card">
      <p class="eyebrow">🖼️</p>
      <h1 class="event-name">${esc(heading)}</h1>
      <p class="note">Add a photo or image to make your invitation special.</p>
      ${options.error ? `<p class="error">${esc(options.error)}</p>` : ''}
      ${preview}
      <form method="post" action="" enctype="multipart/form-data" id="image-form">
        <input id="image-file" class="file-input" type="file" name="image" accept="image/jpeg,image/jpg,image/png,image/webp">
        <div class="choices">
          <button class="btn btn-primary" type="button" id="choose-btn">📱 Choose from Phone</button>
          <button class="btn" type="submit" name="action" value="save" id="continue-btn"${editing || !options.previewSrc ? ' disabled' : ''}>${editing ? 'Save new photo' : 'Continue'}</button>
          ${skipOrKeep}
        </div>
      </form>
    </section>`,
    `<script>
(function () {
  var input = document.getElementById('image-file');
  var preview = document.getElementById('preview');
  var choose = document.getElementById('choose-btn');
  var cont = document.getElementById('continue-btn');
  var form = document.getElementById('image-form');
  if (!input || !preview || !choose || !cont || !form) return;
  choose.addEventListener('click', function () { input.click(); });
  input.addEventListener('change', function () {
    var file = input.files && input.files[0];
    if (!file) return;
    var url = URL.createObjectURL(file);
    preview.src = url;
    preview.classList.add('show');
    cont.disabled = false;
  });
  form.addEventListener('submit', function (event) {
    var submitter = event.submitter;
    var action = submitter && submitter.getAttribute('value');
    if (action === 'skip' || action === 'keep' || action === 'remove') return;
    if (!(input.files && input.files[0])) {
      event.preventDefault();
    }
  });
})();
</script>`,
  );
}

export function renderEventImageDonePage(editing = false): string {
  return renderConnectLayout(
    editing ? 'Photo updated — CONNECT' : 'Photo saved — CONNECT',
    `<section class="card">
      <p class="eyebrow">✅</p>
      <h1 class="event-name">${editing ? 'Photo updated' : 'Photo saved'}</h1>
      <p class="note">Return to WhatsApp to continue.</p>
    </section>`,
  );
}

export function renderInvalidEventImagePage(): string {
  return renderConnectLayout(
    'Link expired — CONNECT',
    `<section class="card">
      <p class="eyebrow">🔗</p>
      <h1 class="event-name">This link isn’t available</h1>
      <p class="note">Open the latest Event Image link from WhatsApp, or skip the photo there.</p>
    </section>`,
  );
}
