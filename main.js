// ── Helpers ───────────────────────────────────────────────────────────────────

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach(b => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// "vine-whip" → "Vine Whip"
function formatName(slug) {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Reverse: "Vine Whip" → "vine-whip" for PokeAPI lookups
function toSlug(name) {
  return name.toLowerCase().trim().replace(/\s+/g, '-');
}

function githubHeaders() {
  return {
    Authorization: `token ${CONFIG.token}`,
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github.v3+json',
  };
}

const EGGS_PATH = 'eggs.json';
const API_BASE  = `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/contents`;

// ── GitHub API ────────────────────────────────────────────────────────────────

async function fetchEggsFromGitHub() {
  const res = await fetch(`${API_BASE}/${EGGS_PATH}`, {
    headers: githubHeaders(),
    cache: 'no-store', // always fetch fresh — never use a cached SHA
  });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const data = await res.json();
  const content = atob(data.content.replace(/\n/g, ''));
  return { eggs: JSON.parse(content), sha: data.sha };
}

async function saveEggsToGitHub(eggs, sha, commitMessage) {
  const body = JSON.stringify({
    message: commitMessage,
    content: toBase64(JSON.stringify(eggs, null, 2) + '\n'),
    sha,
    branch: CONFIG.branch,
  });
  const res = await fetch(`${API_BASE}/${EGGS_PATH}`, {
    method: 'PUT',
    headers: githubHeaders(),
    body,
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const err = new Error(errBody.message || `GitHub API error: ${res.status}`);
    err.status = res.status; // attach status so retry logic can check it reliably
    throw err;
  }
  return res.json();
}

// ── PokeAPI list loading with localStorage cache ───────────────────────────────

const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

async function fetchListWithCache(cacheKey, url, extractor) {
  const raw = localStorage.getItem(cacheKey);
  if (raw) {
    try {
      const { data, ts } = JSON.parse(raw);
      if (Date.now() - ts < CACHE_TTL) return data;
    } catch { /* corrupt cache, re-fetch */ }
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`List fetch failed: ${url}`);
  const json = await res.json();
  const data = extractor(json);
  localStorage.setItem(cacheKey, JSON.stringify({ data, ts: Date.now() }));
  return data;
}

function extractNames(json) {
  return json.results.map(r => formatName(r.name));
}

async function loadPokemonList() {
  // Gen 7 = national dex #1–807 (through Zeraora / USUM)
  return fetchListWithCache(
    'egglocke-pokemon-gen7',
    'https://pokeapi.co/api/v2/pokemon?limit=807',
    extractNames
  );
}

async function loadMoveList() {
  // ~728 moves available in USUM; use 750 to be safe
  return fetchListWithCache(
    'egglocke-moves-gen7',
    'https://pokeapi.co/api/v2/move?limit=750',
    extractNames
  );
}

async function loadAbilityList() {
  // Gen 7 adds abilities up to ~233
  return fetchListWithCache(
    'egglocke-abilities-gen7',
    'https://pokeapi.co/api/v2/ability?limit=250',
    extractNames
  );
}

async function loadItemList() {
  const cacheKey = 'egglocke-items-gen7';
  const raw = localStorage.getItem(cacheKey);
  if (raw) {
    try {
      const { data, ts } = JSON.parse(raw);
      if (Date.now() - ts < CACHE_TTL) return data;
    } catch { /* re-fetch */ }
  }

  // Fetch all three holdable item attributes in parallel
  const attrs = ['holdable', 'holdable-passive', 'holdable-active'];
  const results = await Promise.all(
    attrs.map(attr =>
      fetch(`https://pokeapi.co/api/v2/item-attribute/${attr}/`)
        .then(r => r.json())
        .then(d => d.items.map(i => formatName(i.name)))
        .catch(() => [])
    )
  );

  const data = [...new Set(results.flat())].sort();
  localStorage.setItem(cacheKey, JSON.stringify({ data, ts: Date.now() }));
  return data;
}

// ── Custom searchable select ───────────────────────────────────────────────────
// Attaches to: <div class="ss-wrapper"><input /><div class="ss-dropdown"><div class="ss-list"></div></div></div>

function initSearchSelect(inputEl, options, { onSelect } = {}) {
  const wrapper = inputEl.closest('.ss-wrapper');
  const list    = wrapper.querySelector('.ss-list');
  const MAX      = 150; // max options shown at once

  let filtered   = [];
  let activeIdx  = -1;

  function render(query) {
    const q = query.trim().toLowerCase();
    filtered = q
      ? options.filter(o => o.toLowerCase().includes(q)).slice(0, MAX)
      : options.slice(0, MAX);

    list.innerHTML = '';
    if (!filtered.length) {
      list.innerHTML = '<div class="ss-empty">No results</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    filtered.forEach(name => {
      const div = document.createElement('div');
      div.className = 'ss-option';
      div.textContent = name;
      div.addEventListener('mousedown', e => { e.preventDefault(); pick(name); });
      frag.appendChild(div);
    });
    list.appendChild(frag);
    activeIdx = -1;
  }

  function open()  { render(inputEl.value); wrapper.classList.add('ss-open'); }
  function close() { wrapper.classList.remove('ss-open'); activeIdx = -1; }

  function pick(name) {
    inputEl.value = name;
    close();
    // Dispatch input so any listeners (e.g. Pokemon sprite lookup) fire
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    if (onSelect) onSelect(name);
  }

  function setActive(i) {
    const opts = list.querySelectorAll('.ss-option');
    opts.forEach((o, j) => o.classList.toggle('ss-active', j === i));
    opts[i]?.scrollIntoView({ block: 'nearest' });
    activeIdx = i;
  }

  inputEl.addEventListener('focus', open);
  inputEl.addEventListener('input', () => { render(inputEl.value); wrapper.classList.add('ss-open'); });
  inputEl.addEventListener('blur',  () => setTimeout(close, 150));
  inputEl.addEventListener('keydown', e => {
    if (!wrapper.classList.contains('ss-open')) { open(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(activeIdx + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); setActive(Math.max(activeIdx - 1, 0)); }
    else if (e.key === 'Enter' && activeIdx >= 0) { e.preventDefault(); pick(filtered[activeIdx]); }
    else if (e.key === 'Escape')    { close(); }
  });
}

// ── PokeAPI single-Pokemon lookup ─────────────────────────────────────────────

async function lookupPokemon(nameOrId) {
  const slug = toSlug(String(nameOrId));
  const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${slug}`);
  if (!res.ok) throw new Error('Pokemon not found');
  const data = await res.json();
  return {
    id: data.id,
    name: data.name,
    spriteUrl:
      data.sprites.front_default ||
      `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${data.id}.png`,
  };
}

// ── Gallery Page ──────────────────────────────────────────────────────────────

function renderEggCard(egg) {
  const moves = (egg.moves || []).filter(Boolean);

  const moveBadges = moves.length
    ? `<div class="card-moves">${moves
        .map(m => `<span class="move-badge">${m}</span>`)
        .join('')}</div>`
    : '';

  const metaRows = [
    egg.ability && `<div class="card-meta-row"><span class="meta-label">Ability</span><span class="meta-value">${egg.ability}</span></div>`,
    egg.item    && `<div class="card-meta-row"><span class="meta-label">Item</span><span class="meta-value">${egg.item}</span></div>`,
  ]
    .filter(Boolean)
    .join('');

  const card = document.createElement('article');
  card.className = 'egg-card';
  card.innerHTML = `
    <div class="card-sprite">
      <img src="${egg.spriteUrl}" alt="${egg.pokemon}" loading="lazy" />
    </div>
    <div class="card-pokemon-name">${capitalize(egg.pokemon)}</div>
    ${egg.nickname ? `<div class="card-nickname">"${egg.nickname}"</div>` : ''}
    <hr class="card-divider" />
    ${metaRows ? `<div class="card-meta">${metaRows}</div>` : ''}
    ${moveBadges}
    ${egg.message ? `<p class="card-message">${egg.message}</p>` : ''}
    <div class="card-submitter">From <strong>${egg.submitter}</strong></div>
  `;
  return card;
}

async function initGallery() {
  const loading   = document.getElementById('loading');
  const emptyState= document.getElementById('empty-state');
  const grid      = document.getElementById('eggs-grid');
  const statsBar  = document.getElementById('stats-bar');
  const countText = document.getElementById('egg-count-text');

  try {
    const { eggs } = await fetchEggsFromGitHub();

    loading.classList.add('hidden');

    if (!eggs.length) {
      emptyState.classList.remove('hidden');
      return;
    }

    statsBar.classList.remove('hidden');
    countText.textContent = `${eggs.length} egg${eggs.length === 1 ? '' : 's'} submitted`;

    grid.classList.remove('hidden');
    // newest first
    [...eggs].reverse().forEach(egg => grid.appendChild(renderEggCard(egg)));
  } catch (err) {
    loading.innerHTML = `<p style="color:var(--red)">Failed to load eggs: ${err.message}</p>`;
  }
}

// ── Submit Form Page ──────────────────────────────────────────────────────────

function initSubmitForm() {
  const form        = document.getElementById('egg-form');
  const pokemonInput= document.getElementById('pokemon-input');
  const feedback    = document.getElementById('pokemon-feedback');
  const preview     = document.getElementById('pokemon-preview');
  const sprite      = document.getElementById('pokemon-sprite');
  const nameLabel   = document.getElementById('pokemon-name-label');
  const submitBtn   = document.getElementById('submit-btn');
  const submitLabel = document.getElementById('submit-label');
  const formError   = document.getElementById('form-error');
  const successState= document.getElementById('success-state');
  const successDetail = document.getElementById('success-detail');

  // Kick off list loading in the background — wire up searchable selects as each list arrives
  Promise.all([
    loadPokemonList(),
    loadMoveList(),
    loadAbilityList(),
    loadItemList(),
  ]).then(([pokemon, moves, abilities, items]) => {
    initSearchSelect(pokemonInput, pokemon);
    initSearchSelect(document.getElementById('ability'), abilities);
    initSearchSelect(document.getElementById('item'), items);
    ['move1', 'move2', 'move3', 'move4'].forEach(name => {
      const el = form.elements[name];
      if (el) initSearchSelect(el, moves);
    });
  }).catch(err => console.warn('Some lists failed to load:', err));

  let pokemonData = null; // { id, name, spriteUrl }
  let lookupTimer = null;

  // Live Pokemon lookup as user types
  pokemonInput.addEventListener('input', () => {
    clearTimeout(lookupTimer);
    pokemonData = null;
    feedback.textContent = '';
    feedback.className = 'field-feedback';
    preview.classList.add('hidden');

    const val = pokemonInput.value.trim();
    if (!val) return;

    feedback.textContent = 'Looking up…';
    lookupTimer = setTimeout(async () => {
      try {
        pokemonData = await lookupPokemon(val);
        feedback.textContent = `✓ ${capitalize(pokemonData.name)} (#${pokemonData.id})`;
        feedback.className = 'field-feedback ok';
        sprite.src = pokemonData.spriteUrl;
        sprite.alt = pokemonData.name;
        nameLabel.textContent = capitalize(pokemonData.name);
        preview.classList.remove('hidden');
      } catch {
        feedback.textContent = '✗ Pokemon not found';
        feedback.className = 'field-feedback err';
      }
    }, 600);
  });

  // Form submit
  form.addEventListener('submit', async e => {
    e.preventDefault();
    formError.classList.add('hidden');

    const submitter = form.submitter.value.trim();

    if (!submitter) {
      showError('Please enter your trainer name.');
      return;
    }
    if (!pokemonData) {
      showError('Please enter a valid Pokemon name and wait for it to be confirmed.');
      return;
    }

    const moves = [
      form.move1.value.trim(),
      form.move2.value.trim(),
      form.move3.value.trim(),
      form.move4.value.trim(),
    ].filter(Boolean);

    const newEgg = {
      id:          String(Date.now()),
      submitter,
      pokemon:     pokemonData.name,
      pokemonId:   pokemonData.id,
      spriteUrl:   pokemonData.spriteUrl,
      nickname:    form.nickname.value.trim(),
      ability:     form.ability.value.trim(),
      item:        form.item.value.trim(),
      moves,
      message:     form.message.value.trim(),
      submittedAt: new Date().toISOString(),
    };

    setLoading(true);

    // Retry up to 3 times on SHA conflict (another submission landed between
    // our fetch and our PUT — just re-fetch and try again).
    const MAX_RETRIES = 3;
    let lastErr;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 1) {
          setLoading(true, `Retrying… (${attempt}/${MAX_RETRIES})`);
          await new Promise(r => setTimeout(r, 500 * attempt)); // brief back-off
        }
        const { eggs, sha } = await fetchEggsFromGitHub();
        eggs.push(newEgg);
        await saveEggsToGitHub(
          eggs,
          sha,
          `Add egg from ${submitter} (${capitalize(pokemonData.name)})`
        );

        form.classList.add('hidden');
        successState.classList.remove('hidden');
        successDetail.textContent = `${capitalize(pokemonData.name)}${newEgg.nickname ? ` (nicknamed "${newEgg.nickname}")` : ''} from ${submitter} has been added to the egg pool.`;
        setLoading(false);
        return; // success — exit the submit handler
      } catch (err) {
        lastErr = err;
        // Only retry on SHA/ref conflicts (409 or 422); surface all other errors immediately
        const isConflict = err.status === 409 || err.status === 422;
        if (!isConflict) break;
      }
    }

    showError(`Submission failed: ${lastErr.message}`);
    setLoading(false);
  });

  function showError(msg) {
    formError.textContent = msg;
    formError.classList.remove('hidden');
    formError.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function setLoading(on, label) {
    submitBtn.disabled = on;
    submitLabel.textContent = on ? (label || 'Submitting…') : 'Submit Egg 🥚';
  }
}
