'use strict';
/* ========== Utilidades ========== */
const $ = (s, r = document) => r.querySelector(s);
const CODIGOS_VALIDOS = ['LECTOR2026', 'ANTHOPHILA', 'YARADA26', 'DEMO26', 'VIP-KILLA'];
const Auth = {
  get isSubscriber() {
    return localStorage.getItem('auth_subscriber') === 'true';
  },
  get isLoggedIn() {
    return this.isSubscriber;
  },
  activate(code) {
    const normalized = String(code || '').trim().toUpperCase();
    if (!CODIGOS_VALIDOS.includes(normalized)) return false;
    localStorage.setItem('auth_subscriber', 'true');
    return true;
  },
};

function restoreAuth() {
  if (localStorage.getItem('anthophila-demo-code') === 'ANTHOPHILA-DEMO') {
    localStorage.setItem('auth_subscriber', 'true');
    localStorage.removeItem('anthophila-demo-code');
  }
}

function safeAssetUrl(path) {
  if (!path) return '';
  const url = new URL(path, document.baseURI);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== location.origin) {
    throw new Error('Los EPUB y portadas deben estar alojados en este mismo sitio.');
  }
  return url.href;
}

const DB = (() => {
  let database;
  function open() {
    if (!database) {
      database = new Promise((resolve, reject) => {
        const request = indexedDB.open('anthophila-library', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('books', { keyPath: 'id' });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return database;
  }
  async function request(mode, operation) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('books', mode);
      const req = operation(tx.objectStore('books'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error || new Error('La transacción de IndexedDB fue cancelada.'));
    });
  }
  return {
    all: () => request('readonly', store => store.getAll()),
    put: book => request('readwrite', store => store.put(book)),
  };
})();

async function parseEpub(file, metadata) {
  const blob = file instanceof Blob ? file : new Blob([file], { type: 'application/epub+zip' });
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const readXml = async path => {
    const entry = zip.file(path);
    if (!entry) throw new Error(`Falta ${path} dentro del EPUB.`);
    return new DOMParser().parseFromString(await entry.async('text'), 'application/xml');
  };
  const container = await readXml('META-INF/container.xml');
  const opfPath = container.querySelector('rootfile')?.getAttribute('full-path');
  if (!opfPath) throw new Error('No se encontró el paquete OPF del EPUB.');
  const opf = await readXml(opfPath);
  const metadataElements = [...opf.getElementsByTagName('meta')];
  const title = opf.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'title')[0]?.textContent.trim();
  const author = opf.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'creator')[0]?.textContent.trim();
  const description = metadataElements.find(meta => meta.getAttribute('property') === 'schema:accessibilitySummary')?.textContent.trim()
    || opf.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'description')[0]?.textContent.trim();
  const items = [...opf.querySelectorAll('manifest > item')];
  let cover = items.find(item => (item.getAttribute('properties') || '').split(/\s+/).includes('cover-image'));
  if (!cover) {
    const legacyId = metadataElements.find(meta => meta.getAttribute('name') === 'cover')?.getAttribute('content');
    cover = items.find(item => item.getAttribute('id') === legacyId);
  }
  let coverBlob = null;
  if (cover?.getAttribute('href')) {
    const coverPath = decodeURIComponent(new URL(cover.getAttribute('href'), `http://epub/${opfPath}`).pathname.slice(1));
    const coverFile = zip.file(coverPath);
    if (coverFile) {
      coverBlob = new Blob([await coverFile.async('arraybuffer')], {
        type: cover.getAttribute('media-type') || 'image/jpeg',
      });
    }
  }
  return {
    ...metadata,
    title: metadata.title || title || metadata.id,
    author: metadata.author || author || '',
    description: metadata.description || description || 'Cuento infantil interactivo.',
    file: blob,
    coverBlob,
  };
}

/* ========== Módulo Galería ========== */
const Gallery = (() => {
  const grid = $('#catalogo'), empty = $('#empty'), count = $('#count');
  const status = $('#catalog-status'), fstatus = $('#filter-status'), filters = $('.filters');
  const search = $('#search'), categorySel = $('#filter-category'), gradeSel = $('#filter-grade');
  const filterAll = $('#filter-all'), filterNew = $('#filter-new');
  const books = new Map();
  const coverUrls = new Map();
  const coverLoads = new Map();
  let newFilter = 'all';
  const categories = new Set(['tacna', 'puno', 'cusco', 'arequipa', 'moquegua', 'selva', 'cristianos', 'variados']);
  // Normaliza para buscar sin distinguir mayúsculas ni tildes ("Cosecha" = "cosechá").
  const fold = s => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

  async function loadCatalog() {
    const response = await fetch(new URL('catalog.json', document.baseURI));
    if (!response.ok) throw new Error(`No se pudo cargar el catálogo (${response.status}).`);
    const data = await response.json();
    if (!Array.isArray(data.books)) throw new Error('El catálogo debe incluir una lista "books".');
    let cached = [];
    const warnings = [];
    try {
      cached = await DB.all();
    } catch (error) {
      console.error('[IndexedDB] No se pudo leer la biblioteca local:', error);
      warnings.push('No se pudo leer la caché local.');
    }
    books.clear();
    for (const item of data.books) {
      const book = { ...item };
      if (!book.id || !book.title || !book.src) throw new Error('Cada cuento necesita id, title y src en catalog.json.');
      book.src = safeAssetUrl(book.src);
      book.cover = book.cover ? safeAssetUrl(book.cover) : '';
      if (book.music?.src) book.music.src = safeAssetUrl(book.music.src);
      if (book.video?.embedUrl) book.video.embedUrl = safeVideoEmbedUrl(book.video.embedUrl);
      book.description ||= 'Cuento infantil interactivo.';
      book.author ||= '';
      book.tag ||= 'Cuento';
      book.category = String(book.category || 'variados').trim().toLowerCase();
      if (!categories.has(book.category)) {
        throw new Error(`Categoría no válida en «${book.title}»: ${book.category}`);
      }
      book.grade ||= 'sin-especificar';
      book.gradeLabel ||= 'Sin grado especificado';
      book.isNew = book.isNew === true;
      book.free = book.free === true;
      if (books.has(book.id)) throw new Error(`Identificador de libro duplicado: ${book.id}`);
      try {
        const epubResponse = await fetch(book.src);
        if (!epubResponse.ok) throw new Error(`HTTP ${epubResponse.status}`);
        const parsed = await parseEpub(await epubResponse.blob(), book);
        Object.assign(book, parsed);
        try {
          await DB.put(book);
        } catch (error) {
          console.error(`[IndexedDB] No se pudo guardar «${book.title}»:`, error);
          warnings.push(`No se pudo guardar «${book.title}» en la caché.`);
        }
      } catch (error) {
        const previous = cached.find(entry => entry.id === book.id && entry.src === book.src);
        if (previous) Object.assign(book, previous, item, { src: book.src, cover: item.cover ? safeAssetUrl(item.cover) : '' });
        else {
          console.error(`[Catálogo] No se pudo preparar «${book.title}»:`, error);
          warnings.push(`No se pudo cargar «${book.title}» (${error.message}).`);
        }
      }
      books.set(book.id, book);
    }
    render();
    renderBibliotecasMultimedia([...books.values()]);
    status.textContent = warnings.join(' ');
    status.classList.toggle('err', warnings.length > 0);
  }

  async function extractEmbeddedCover(book) {
    if (book.coverBlob) return book.coverBlob;
    if (coverLoads.has(book.id)) return coverLoads.get(book.id);
    const loading = (async () => {
      let epubBlob = book.file;
      if (!(epubBlob instanceof Blob)) {
        const response = await fetch(book.src);
        if (!response.ok) throw new Error(`No se pudo cargar el EPUB (${response.status}).`);
        epubBlob = await response.blob();
      }
      const parsed = await parseEpub(epubBlob, book);
      if (!parsed.coverBlob) throw new Error('El EPUB no declara una portada utilizable.');
      book.coverBlob = parsed.coverBlob;
      return parsed.coverBlob;
    })();
    coverLoads.set(book.id, loading);
    try {
      return await loading;
    } finally {
      coverLoads.delete(book.id);
    }
  }

  function card(b) {
    const li = document.createElement('li');
    li.dataset.id = b.id;
    li.dataset.tag = b.tag || '';
    li.dataset.search = fold(`${b.title || ''} ${b.author || ''} ${b.description || ''} ${b.tag || ''} ${b.gradeLabel || ''} ${b.category || ''}`); // índice de búsqueda

    // --- Procesamiento robusto de la portada ---
    let coverSrc = null;

    if (b.cover) {
      if (b.cover instanceof Blob) {
        // Portada binaria extraída del archivo EPUB
        coverSrc = URL.createObjectURL(b.cover);
        if (typeof coverUrls !== 'undefined') {
          coverUrls.set(b.id, coverSrc);
        }
      } else if (typeof b.cover === 'string' && b.cover.trim() !== '') {
        // Ruta directa especificada en catalog.json (ej: "portadas/portada_cosecha.jpg")
        coverSrc = b.cover;
      }
    } else if (b.coverUrl && typeof b.coverUrl === 'string' && b.coverUrl.trim() !== '') {
      coverSrc = b.coverUrl;
    }

    const cover = `<span class="cover-fallback"${coverSrc ? ' hidden' : ''} aria-hidden="true">${esc(b.title)}</span>
      <img class="cover-image"${coverSrc ? ` src="${esc(coverSrc)}"` : ' hidden'} alt="Portada de ${esc(b.title)}" loading="lazy">
      ${b.isNew ? '<span class="badge-new" aria-label="Libro nuevo">✨ Nuevo</span>' : ''}`;

    // --- Botones según estado de suscripción ---
    const actions = (b.free || (typeof Auth !== 'undefined' && Auth.isSubscriber))
      ? `<button class="btn btn-main" data-read>📖 Leer ahora<span class="sr">: ${esc(b.title)}</span></button>`
      : `<button class="btn btn-ghost" data-preview>📖 Leer muestra gratis<span class="sr">: ${esc(b.title)}</span></button>
         <button class="btn btn-main" data-subscribe>⭐ Desbloquear con suscripción<span class="sr">: ${esc(b.title)}</span></button>`;

    li.innerHTML = `
      <article class="card">
        <div class="cover">${cover}</div>
        <div class="card-body">
          <h3>${esc(b.title)}</h3>
          ${b.tag ? `<span class="tag">${esc(b.tag)}</span>` : ''}
          <p class="sum">${esc(b.description || '')}</p>
          <div class="card-actions">
            ${actions}
          </div>
        </div>
      </article>`;

    const coverImage = li.querySelector('.cover-image');
    const coverFallback = li.querySelector('.cover-fallback');
    const useEmbeddedCover = async () => {
      try {
        const blob = await extractEmbeddedCover(b);
        if (!grid.contains(li)) return;
        const oldUrl = coverUrls.get(b.id);
        if (oldUrl) URL.revokeObjectURL(oldUrl);
        const objectUrl = URL.createObjectURL(blob);
        coverUrls.set(b.id, objectUrl);
        coverImage.src = objectUrl;
        coverImage.hidden = false;
        coverFallback.hidden = true;
      } catch (error) {
        console.warn(`No se pudo mostrar la portada de «${b.title}»:`, error);
        coverImage.hidden = true;
        coverFallback.hidden = false;
      }
    };
    coverImage.addEventListener('error', useEmbeddedCover, { once: true });
    if (!coverSrc) useEmbeddedCover();

    // --- Event listeners ---
    li.querySelector('[data-read]')?.addEventListener('click', e => Reader.open(b, e.currentTarget));
    li.querySelector('[data-preview]')?.addEventListener('click', e => Reader.open(b, e.currentTarget));
    li.querySelector('[data-subscribe]')?.addEventListener('click', () => {
      if (typeof openAccessDialog === 'function') {
        openAccessDialog('plans');
      } else {
        const modalAuth = document.getElementById('modal-auth');
        if (modalAuth && typeof modalAuth.showModal === 'function') {
          modalAuth.showModal();
        } else {
          alert('Para acceder al contenido completo, por favor comunícate para activar tu suscripción.');
        }
      }
    });

    return li;
  }

  function render() {
    coverUrls.forEach(url => URL.revokeObjectURL(url));
    coverUrls.clear();
    grid.replaceChildren(...[...books.values()].map(card));
    buildGradeOptions(); applyFilter();
  }

  function buildGradeOptions() {
    const selected = gradeSel.value;
    const known = new Set([...gradeSel.options].map(option => option.value));
    const grades = new Map([...books.values()]
      .filter(book => !known.has(book.grade))
      .map(book => [book.grade, book.gradeLabel]));
    const extra = [...grades].map(([value, label]) => new Option(label, value));
    if (extra.length) gradeSel.add(...extra);
    gradeSel.value = [...gradeSel.options].some(option => option.value === selected) ? selected : '';
  }

  /** Filtra en tiempo real mostrando u ocultando las tarjetas ya cargadas. */
  function applyFilter() {
    const terms = fold(search.value).split(/\s+/).filter(Boolean);
    const category = categorySel.value, grade = gradeSel.value;
    let shown = 0;
    for (const li of grid.children) {
      const book = books.get(li.dataset.id);
      const matches = book
        && (!category || book.category === category)
        && (!grade || book.grade === grade)
        && (newFilter !== 'new' || book.isNew)
        && terms.every(term => li.dataset.search.includes(term));
      const ok = Boolean(matches);
      li.hidden = !ok; if (ok) shown++;
    }
    count.textContent = !books.size ? '' : shown === books.size ? `${books.size} cuentos` : `${shown} de ${books.size} cuentos`;
    filters.hidden = !books.size;
    empty.textContent = books.size
      ? 'No hay cuentos que coincidan con los filtros seleccionados.'
      : 'No hay cuentos disponibles todavía.';
    empty.hidden = shown > 0;
    return shown;
  }
  let announceTimer;
  function onFilter() {
    const shown = applyFilter();
    clearTimeout(announceTimer);   // anuncia el resultado a lectores de pantalla sin saturar mientras se escribe
    announceTimer = setTimeout(() => {
      fstatus.textContent = `${shown} ${shown === 1 ? 'libro encontrado' : 'libros encontrados'}.`;
    }, 500);
  }

  function init() {
    search.addEventListener('input', onFilter);
    categorySel.addEventListener('change', onFilter);
    gradeSel.addEventListener('change', onFilter);
    [filterAll, filterNew].forEach(button => button.addEventListener('click', () => {
      newFilter = button.dataset.filter;
      filterAll.classList.toggle('active', newFilter === 'all');
      filterNew.classList.toggle('active', newFilter === 'new');
      filterAll.setAttribute('aria-pressed', String(newFilter === 'all'));
      filterNew.setAttribute('aria-pressed', String(newFilter === 'new'));
      onFilter();
    }));
    return loadCatalog().catch(error => {
      console.error('[Catálogo]', error);
      status.textContent = `No se pudo cargar el catálogo. ${error.message}`;
      status.classList.add('err');
      empty.hidden = true;
    });
  }
  return { init, render, getEmbeddedCover: extractEmbeddedCover };
})();

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function safeVideoEmbedUrl(value) {
  const url = new URL(value, document.baseURI);
  const hosts = ['youtube.com', 'www.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'];
  if (url.protocol !== 'https:' || !hosts.includes(url.hostname) || !/^\/embed\/[A-Za-z0-9_-]{11}$/.test(url.pathname)) {
    throw new Error('Los videos deben usar una URL segura de inserción de YouTube.');
  }
  return url.href;
}

const mediaCoverUrls = new Set();
function renderBibliotecasMultimedia(libros) {
  const musicGrid = $('#grid-musica'), videoGrid = $('#grid-videos');
  mediaCoverUrls.forEach(url => URL.revokeObjectURL(url));
  mediaCoverUrls.clear();
  const createCard = (title, bookTitle, duration, includeCover = false) => {
    const card = document.createElement('article');
    card.className = 'card-media';
    if (includeCover) {
      const cover = document.createElement('div');
      cover.className = 'media-cover';
      const image = document.createElement('img');
      image.alt = `Portada de ${bookTitle}`;
      image.loading = 'lazy';
      const fallback = document.createElement('span');
      fallback.textContent = bookTitle;
      cover.append(image, fallback);
      card.append(cover);
    }
    const heading = document.createElement('h2');
    heading.textContent = title;
    const book = document.createElement('p');
    book.textContent = bookTitle;
    card.append(heading, book);
    if (duration) {
      const length = document.createElement('p');
      length.textContent = `Duración: ${duration}`;
      card.append(length);
    }
    return card;
  };

  musicGrid.replaceChildren();
  videoGrid.replaceChildren();
  for (const libro of libros) {
    if (libro.music) {
      const card = createCard(libro.music.title, libro.title, libro.music.duration, true);
      const mediaCover = card.querySelector('.media-cover');
      const coverImage = card.querySelector('.media-cover img');
      const coverFallback = card.querySelector('.media-cover span');
      const catalogCover = typeof libro.cover === 'string' ? libro.cover : '';
      let triedCatalogCover = false;
      coverImage.addEventListener('load', () => {
        mediaCover.classList.add('has-image');
        coverFallback.hidden = true;
      });
      coverImage.addEventListener('error', () => {
        if (!triedCatalogCover && catalogCover) {
          triedCatalogCover = true;
          coverImage.src = catalogCover;
          return;
        }
        mediaCover.classList.remove('has-image');
        coverFallback.hidden = false;
      }, { once: true });
      Gallery.getEmbeddedCover(libro).then(blob => {
        if (!coverImage.isConnected) return;
        const url = URL.createObjectURL(blob);
        mediaCoverUrls.add(url);
        coverImage.src = url;
      }).catch(error => {
        console.warn(`No se pudo extraer la portada del EPUB de «${libro.title}» para la biblioteca de música:`, error);
        if (coverImage.isConnected && catalogCover) coverImage.src = catalogCover;
      });
      if (libro.music.src) {
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.preload = 'none';
        audio.src = safeAssetUrl(libro.music.src);
        audio.setAttribute('aria-label', `Reproducir ${libro.music.title}`);
        card.append(audio);
      } else {
        const pending = document.createElement('p');
        pending.className = 'media-pending';
        pending.textContent = 'Audio próximamente.';
        card.append(pending);
      }
      musicGrid.append(card);
    }
    if (libro.video) {
      const card = createCard(libro.video.title, libro.title, libro.video.duration);
      if (libro.video.embedUrl) {
        const wrapper = document.createElement('div');
        wrapper.className = 'video-wrapper';
        const frame = document.createElement('iframe');
        frame.src = safeVideoEmbedUrl(libro.video.embedUrl);
        frame.title = libro.video.title;
        frame.loading = 'lazy';
        frame.referrerPolicy = 'strict-origin-when-cross-origin';
        frame.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
        frame.allowFullscreen = true;
        wrapper.append(frame);
        card.append(wrapper);
      } else {
        const pending = document.createElement('p');
        pending.className = 'media-pending';
        pending.textContent = 'Video próximamente. Agrega una URL de inserción de YouTube en catalog.json.';
        card.append(pending);
      }
      videoGrid.append(card);
    }
  }
}

function initMediaTabs() {
  const tabs = [...document.querySelectorAll('.media-tabs [role="tab"]')];
  const selectTab = selected => {
    for (const tab of tabs) {
      const active = tab === selected;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      $(`#${tab.getAttribute('aria-controls')}`).hidden = !active;
    }
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', event => {
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
        : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
          : event.key === 'Home' ? 0
            : event.key === 'End' ? tabs.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault();
      tabs[next].focus();
      selectTab(tabs[next]);
    });
  });
}

function initCarousel() {
  const carousel = $('.carousel-container');
  const slides = [...carousel.querySelectorAll('.carousel-slide')];
  const dots = [...carousel.querySelectorAll('.dot')];
  const previous = $('#carousel-prev'), next = $('#carousel-next');
  const toggle = $('#carousel-toggle'), status = $('#carousel-status');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let current = 0, timer = null, manuallyPaused = reduceMotion.matches;
  let hovered = false, focused = false;

  function stopTimer() {
    clearInterval(timer);
    timer = null;
  }
  function startTimer() {
    stopTimer();
    if (!manuallyPaused && !hovered && !focused && !document.hidden) {
      timer = setInterval(() => showSlide(current + 1), 4000);
    }
  }
  function showSlide(index) {
    current = (index + slides.length) % slides.length;
    slides.forEach((slide, i) => { slide.hidden = i !== current; });
    dots.forEach((dot, i) => {
      const active = i === current;
      dot.classList.toggle('is-active', active);
      dot.setAttribute('aria-current', String(active));
    });
    status.textContent = `Anuncio ${current + 1} de ${slides.length}: ${slides[current].querySelector('h2').textContent}`;
    startTimer();
  }
  function updateToggle() {
    const paused = manuallyPaused;
    toggle.textContent = paused ? 'Reanudar' : 'Pausar';
    toggle.setAttribute('aria-label', paused ? 'Reanudar rotación automática' : 'Pausar rotación automática');
    toggle.setAttribute('aria-pressed', String(paused));
  }

  previous.addEventListener('click', () => showSlide(current - 1));
  next.addEventListener('click', () => showSlide(current + 1));
  dots.forEach((dot, index) => dot.addEventListener('click', () => showSlide(index)));
  toggle.addEventListener('click', () => {
    manuallyPaused = !manuallyPaused;
    updateToggle();
    startTimer();
  });
  carousel.addEventListener('mouseenter', () => { hovered = true; stopTimer(); });
  carousel.addEventListener('mouseleave', () => { hovered = false; startTimer(); });
  carousel.addEventListener('focusin', () => { focused = true; stopTimer(); });
  carousel.addEventListener('focusout', event => {
    if (!carousel.contains(event.relatedTarget)) {
      focused = false;
      startTimer();
    }
  });
  document.addEventListener('visibilitychange', startTimer);
  reduceMotion.addEventListener?.('change', event => {
    if (event.matches) {
      manuallyPaused = true;
      updateToggle();
      stopTimer();
    }
  });
  carousel.querySelectorAll('[data-open-tab]').forEach(button => {
    button.addEventListener('click', () => {
      const tab = $(`#tab-btn-${button.dataset.openTab.replace('tab-', '')}`);
      tab?.click();
      tab?.focus();
    });
  });
  updateToggle();
  startTimer();
}

function openAccessDialog(mode = 'plans') {
  const dialog = $('#modal-auth');
  const title = $('#access-title'), message = $('#access-message');
  const status = $('#access-status');
  status.textContent = '';
  status.classList.remove('err');
  $('#activation-code').removeAttribute('aria-invalid');
  title.textContent = 'Acceso a la Biblioteca Digital Anthophila';
  message.textContent = mode === 'login'
    ? 'Ingresa el código de licencia que recibiste para activar tu acceso.'
    : 'Activa tu suscripción o consulta los datos para realizar el pago.';
  if (!dialog.open) dialog.showModal();
  $('#activation-code').focus();
}

function updateUserStatus() {
  const status = $('#user-status');
  status.textContent = Auth.isSubscriber ? 'Acceso completo activado' : '';
  $('#btn-login').textContent = Auth.isLoggedIn ? '🔑 Suscripción activa' : '🔑 Ingresar clave / Suscripción';
}

/* ========== Carga de respaldo de epub.js ========== */
function ensureEpubJs() {
  if (window.ePub) return Promise.resolve();
  return new Promise((res, rej) => {
    const sc = document.createElement('script');
    sc.src = 'https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.min.js';
    sc.onload = () => window.ePub ? res() : rej(new Error('epub.js no se inicializó'));
    sc.onerror = () => rej(new Error('No se pudo descargar epub.js desde el CDN.'));
    document.head.append(sc);
  });
}

/* ========== Narración sincronizada (SMIL / Media Overlays) ========== */
const clock = v => { v = (v || '0').trim(); return v.includes(':') ? v.split(':').reduce((a, x) => a * 60 + parseFloat(x), 0) : parseFloat(v); };

async function loadOverlays(buf) {
  const zip = await JSZip.loadAsync(buf);
  const parse = async p => new DOMParser().parseFromString(await zip.file(p).async('text'), 'application/xml');
  const resolve = (href, base) => decodeURIComponent(new URL(href, 'http://x/' + base).pathname.slice(1));
  const opfPath = (await parse('META-INF/container.xml')).querySelector('rootfile').getAttribute('full-path');
  const dir = opfPath.replace(/[^/]*$/, '');
  const items = [...(await parse(opfPath)).querySelectorAll('manifest > item')];
  const byId = Object.fromEntries(items.map(i => [i.getAttribute('id'), i]));
  const mime = { wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/ogg' };
  const map = new Map();
  for (const it of items) {
    const mo = byId[it.getAttribute('media-overlay')]; if (!mo) continue;
    const smilPath = dir + mo.getAttribute('href'), smil = await parse(smilPath);
    const pars = []; let audioPath = null;
    smil.querySelectorAll('par').forEach(par => {
      const t = par.querySelector('text'), a = par.querySelector('audio'); if (!t || !a) return;
      audioPath = resolve(a.getAttribute('src'), smilPath);
      pars.push({ id: t.getAttribute('src').split('#')[1], start: clock(a.getAttribute('clipBegin')), end: clock(a.getAttribute('clipEnd')) });
    });
    if (!pars.length || !zip.file(audioPath)) continue;
    const ext = audioPath.split('.').pop().toLowerCase();
    map.set(it.getAttribute('href'), { pars, url: null, blob: async () => new Blob([await zip.file(audioPath).async('arraybuffer')], { type: mime[ext] || 'audio/mpeg' }) });
  }
  return map;
}

const Voice = (() => {
  const btn = $('#btn-voice'), rate = $('#voice-rate'), auto = $('#voice-auto'), info = $('#voice-info');
  const audio = new Audio(), reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let ctx = null, overlays = new Map(), cur = null, raf = 0, activeId = null, playing = false, advancing = false, utter = null, speechRun = 0;

  const key = h => { for (const k of overlays.keys()) if (h && (h === k || h.endsWith('/' + k) || k.endsWith('/' + h))) return k; };
  const norm = h => key(h) || h;
  // epub.js crea su gestor de vistas de forma asíncrona: antes de la primera página estas llamadas pueden fallar.
  const here = () => { try { return ctx?.rendition.currentLocation()?.start?.href; } catch { return undefined; } };
  const contents = () => { try { return ctx?.rendition.getContents()[0]; } catch { return undefined; } };

  function pickBestGoogleVoice(lang) {
    if (!('speechSynthesis' in window)) return null;
    const voices = speechSynthesis.getVoices();
    if (!voices.length) return null;

    const targetLang = (lang || 'es').toLowerCase().slice(0, 2);
    const esVoices = voices.filter(voice => voice.lang.toLowerCase().startsWith(targetLang));
    const googleVoice = esVoices.find(voice =>
      /google/i.test(voice.name) && /(pe|419|us|es|mx)/i.test(`${voice.lang} ${voice.name}`))
      || esVoices.find(voice => /google/i.test(voice.name))
      || esVoices.find(voice => /natural|neural|online/i.test(voice.name));

    if (googleVoice) return googleVoice;

    const targetRegion = (lang || '').toLowerCase().replace('_', '-').split('-')[1];
    return (targetRegion && esVoices.find(voice =>
      voice.lang.toLowerCase().replace('_', '-').split('-')[1] === targetRegion))
      || esVoices.find(voice => /^es[-_](PE|419|MX|US|ES)/i.test(voice.lang))
      || esVoices[0]
      || null;
  }

  function refresh() {
    if (!ctx) { info.textContent = ''; return; }
    info.textContent = key(here()) ? 'Esta escena tiene narración del libro.'
      : ('speechSynthesis' in window ? 'Esta página se leerá con la voz del dispositivo.' : 'Sin narración disponible.');
  }
  function setPlaying(v) { playing = v; btn.textContent = v ? '⏸ Pausar' : '▶ Escuchar'; }
  function cleanRepeatedHeadings(text) {
    return text.replace(/\b(Estación\s+\d+)\s+\1\b/gi, '$1')
      .replace(/\b(Nuestra ruta de hoy)\s+\1\b/gi, '$1');
  }
  function splitSentences(text) {
    return text.match(/[^.!?…]+(?:[.!?…]+|$)/g)?.map(sentence => sentence.trim()).filter(Boolean) || [];
  }
  function speechSegments(body) {
    const vocabLists = [...body.querySelectorAll('.vocab')].map((list, index) => {
      const cards = [...list.children].filter(card => card.matches('div')).map(card => ({
        term: card.querySelector('dt')?.innerText.trim(),
        definitions: [...card.querySelectorAll('dd:not(.vimg)')].map(definition => definition.innerText.trim()).filter(Boolean),
      })).filter(card => card.term || card.definitions.length);
      const marker = `__TTS_VOCAB_${index}__`;
      list.replaceWith(body.ownerDocument.createTextNode(marker));
      return { marker, cards };
    });
    body.querySelectorAll('address, article, aside, blockquote, br, dd, div, dl, dt, figure, footer, h1, h2, h3, h4, header, li, main, nav, ol, p, section, table, ul')
      .forEach(element => {
        element.before(body.ownerDocument.createTextNode(' '));
        element.after(body.ownerDocument.createTextNode(' '));
      });
    const text = cleanRepeatedHeadings(body.textContent.replace(/\s+/g, ' ').trim());
    const segments = [];
    let cursor = 0;

    for (const { marker, cards } of vocabLists) {
      const markerIndex = text.indexOf(marker, cursor);
      if (markerIndex < 0) continue;
      segments.push(...splitSentences(text.slice(cursor, markerIndex)).map(sentence => ({ text: sentence, delay: 300 })));
      for (const card of cards) {
        const sentence = [card.term && `${card.term}.`, ...card.definitions].filter(Boolean).join(' ');
        if (sentence) segments.push({ text: sentence, delay: 500, vocabulary: true });
      }
      cursor = markerIndex + marker.length;
    }

    segments.push(...splitSentences(text.slice(cursor)).map(sentence => ({ text: sentence, delay: 300 })));
    return segments;
  }

  function follow(el, c) {
    if (ctx.flow() === 'paginated') {
      try { const cfi = c.cfiFromNode(el).toString();
        if (new ePub.CFI().compare(cfi, ctx.rendition.currentLocation().end.cfi) > 0) ctx.rendition.display(cfi); } catch {}
    } else el.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  }
  function mark(id) {
    const c = contents(); if (!c) return;
    c.document.querySelectorAll('.mo-active').forEach(e => e.classList.remove('mo-active', '-epub-media-overlay-active'));
    activeId = id; if (!id) return;
    const el = c.document.getElementById(id); if (!el) return;
    el.classList.add('mo-active', '-epub-media-overlay-active'); follow(el, c);
  }
  function tick() {
    const t = audio.currentTime, p = cur.ov.pars.find(p => t >= p.start && t < p.end);
    if (p && p.id !== activeId) mark(p.id);
    raf = requestAnimationFrame(tick);
  }
  async function playSection(k) {
    const ov = overlays.get(k);
    if (!cur || cur.href !== k) {
      ov.url ||= URL.createObjectURL(await ov.blob());
      cur = { href: k, ov };
      await new Promise(r => { audio.onloadedmetadata = r; audio.src = ov.url; });
      audio.currentTime = ov.pars[0].start;
    }
    audio.playbackRate = +rate.value;
    await audio.play(); setPlaying(true); cancelAnimationFrame(raf); tick();
  }
  function speak() {
    const c = contents(); if (!c || !('speechSynthesis' in window)) return;
    const body = c.document.body.cloneNode(true);
    body.querySelectorAll('[aria-hidden="true"]').forEach(element => element.remove());
    const segments = speechSegments(body);
    if (!segments.length) return;

    speechSynthesis.cancel();
    const lang = ctx.book.packaging?.metadata?.language || 'es-PE';
    const selectedVoice = pickBestGoogleVoice(lang);
    const baseRate = +rate.value || 1;
    const run = ++speechRun;
    let index = 0;

    function speakNextSentence() {
      if (run !== speechRun) return;
      if (index >= segments.length) {
        utter = null;
        setPlaying(false);
        return;
      }

      const segment = segments[index];
      if (!segment.text) { index++; speakNextSentence(); return; }

      const u = utter = new SpeechSynthesisUtterance(segment.text);
      u.lang = lang;
      if (selectedVoice) u.voice = selectedVoice;
      u.rate = segment.vocabulary ? 0.85 : Math.max(0.75, Math.min(1.1, baseRate * 0.9));
      u.pitch = 1.05;
      u.onend = () => {
        if (run !== speechRun) return;
        index++;
        window.setTimeout(speakNextSentence, segment.delay);
      };
      u.onerror = event => {
        if (run !== speechRun) return;
        if (event.error === 'canceled' || event.error === 'interrupted') return;
        console.warn('Error en frase TTS:', event);
        index++;
        window.setTimeout(speakNextSentence, segment.delay);
      };
      speechSynthesis.speak(u);
    }

    cur = { href: norm(here()) };
    setPlaying(true);
    speakNextSentence();
  }
  function pause() { speechRun++; audio.pause(); utter = null; speechSynthesis.cancel(); cancelAnimationFrame(raf); setPlaying(false); }
  function stop() { pause(); mark(null); cur = null; }

  audio.onended = async () => {
    if (!ctx) return;
    cancelAnimationFrame(raf); mark(null);
    if (!auto.checked) return setPlaying(false);
    let s = ctx.book.spine.get(cur.href)?.next();
    while (s && !key(s.href)) s = s.next();
    if (!s) return setPlaying(false);
    if (!ctx.canRead(s.href)) { pause(); ctx.onPaywall(); return; }
    advancing = true;
    try { cur = null; await ctx.rendition.display(s.href); await playSection(key(s.href)); }
    catch (e) { console.error(e); setPlaying(false); } finally { advancing = false; }
  };
  btn.onclick = () => {
    if (playing) return pause();
    const k = key(here());
    Promise.resolve().then(() => k ? playSection(k) : speak())
      .catch(e => { console.error(e); info.textContent = 'No se pudo reproducir la narración.'; setPlaying(false); });
  };
  rate.onchange = () => { audio.playbackRate = +rate.value; ctx?.save(rate.value, auto.checked); };
  auto.onchange = () => ctx?.save(rate.value, auto.checked);

  if ('speechSynthesis' in window) speechSynthesis.addEventListener('voiceschanged', refresh);

  return {
    refresh,
    attach(c) { ctx = c; rate.value = String(c.prefs.rate); auto.checked = c.prefs.auto; refresh(); },
    setOverlays(m) { overlays = m; refresh(); },
    /** Se llama en cada 'relocated'. Si la escena visible ya no es la que sonaba (flechas, teclado o índice),
        se detiene lo anterior (audio SMIL o TTS) y se vuelve a detectar qué narración tiene la escena nueva. */
    onRelocated(loc) {
      if (!advancing && cur && norm(loc.start.href) !== cur.href) stop();  // 1) pausar y soltar la escena anterior
      refresh();                                                            // 2) ¿SMIL, TTS o nada en la escena nueva?
    },
    pause,
    reset() { stop(); overlays.forEach(o => o.url && URL.revokeObjectURL(o.url)); overlays = new Map(); audio.removeAttribute('src'); ctx = null; refresh(); },
  };
})();

/* ========== Módulo Lector (epub.js) ========== */
const Reader = (() => {
  const dlg = $('#reader'), tocEl = $('#toc'), btnToc = $('#btn-toc'), btnFlow = $('#btn-flow');
  const paywall = $('#paywall-dialog'), previewSceneLimit = 3;
  let previewOnly = false, previewBoundary = -1, previewStartHref = null;
  let lastAllowedCfi = null, restoringPreview = false;
  /* Temas NATIVOS de epub.js (themes.register / themes.select), sin filtros de inversión.
     epub.js añade al <body> del iframe la clase del tema activo (p. ej. "dark"); por eso cada regla va
     acotada con body.<tema> y cambiar de tema nunca deja reglas de otro tema activas. */
  const makeTheme = (cls, { bg, fg, card, accent, link, recolor }) => {
    const t = `body.${cls}`, txt = ['h1', 'h2', 'h3', 'p', 'span', 'dt', 'dd', 'li', 'label', 'td', 'th', 'summary'].map(e => `${t} ${e}`).join(',');
    const boxes = ['li', 'dl.vocab > div', '.scene-figure', '.story-map-card', '.map-card-figure', 'dd.vimg', 'details', 'table', 'td', 'th', 'input', 'select', 'textarea', 'button', '.rep-ban'].map(e => `${t} ${e}`).join(',');
    const rules = {
      [t]: { background: `${bg} !important`, color: `${fg} !important` },
      [`${t} main`]: { background: `${bg} !important`, 'box-shadow': 'none !important' },
      [`${t} a`]: { color: `${link} !important` },
    };
    if (recolor) {   // sepia y oscuro: recolorear texto y tarjetas; el claro conserva los colores del libro
      rules[txt] = { color: `${fg} !important` };
      rules[boxes] = { 'background-color': `${card} !important`, color: `${fg} !important` };
      rules[`${t} .keyword`] = { color: `${accent} !important` };
      rules[`${t} h1::after`] = { opacity: '.9' };
    }
    return rules;
  };
  const THEMES = {
    light: makeTheme('light', { bg: '#ffffff', fg: '#1e293b', link: '#1d4ed8', recolor: false }),
    sepia: makeTheme('sepia', { bg: '#f4ecd8', fg: '#3c2f1f', card: '#eadfc0', accent: '#7a3e00', link: '#7a3e00', recolor: true }),
    dark:  makeTheme('dark',  { bg: '#121212', fg: '#f1f5f9', card: '#1f1f23', accent: '#fbbf24', link: '#fbbf24', recolor: true }),
  };
  // Resaltado de la narración: el selector es más específico que los temas para que siempre se vea.
  const HL_CSS = 'html body .mo-active{background:#ffd84d!important;color:#000!important;border-radius:4px;box-shadow:0 0 0 3px #ffd84d}'
    + 'html body .mo-active:not(.keyword){font-weight:inherit!important}';
  // Maquetación "una sola vista": usa --rh (alto real del lector) porque vh no sirve dentro del iframe de epub.js.
  const FIT_CSS = 'figure.logo img,img[src*="logo"]{max-height:min(140px,calc(var(--rh,600px)*.2))!important;max-width:45%!important;width:auto!important;height:auto!important}'
    + 'html.epub-single-view,html.epub-single-view body,html.epub-single-view body>main{height:var(--rh,600px)!important;max-height:none!important}'
    + 'html.epub-single-view .cover-page,html.epub-single-view .station1-page,html.epub-single-view .station-page{font-size:1.1em}'
    + 'html.epub-single-view .credit-page,html.epub-single-view .route-page{font-size:1.2em}'
    + 'html.epub-single-view .route-page{width:100%}'
    + 'html.epub-single-view .cover-page img.cover-img{max-height:60vh!important}'
    + 'html.epub-single-view figure.logo img{max-height:min(160px,calc(var(--rh,600px)*.25))!important}'
    + 'html.epub-single-view .station-cover{max-height:34vh!important}'
    + '.cover-img{max-height:calc(var(--rh,600px)*.6)!important;width:auto!important}'
    + 'html.scene body{box-sizing:border-box;width:100%;max-width:100%;overflow-x:hidden;padding:8px}'
    + 'html.scene main{box-sizing:border-box;width:100%;max-width:100%;height:calc(var(--rh) - 16px);min-height:0;display:flex;flex-direction:column;justify-content:center;padding:28px 16px 4px}'
    + 'html.scene section{box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;gap:16px;width:100%;max-width:100%;min-height:0}'
    + 'html.scene .scene-figure{margin:0 0 .4em}html.scene .read-along-segment{margin:0}'
    + 'html.scene .scene-figure{min-width:0;max-width:100%}html.scene .scene-figure img{max-width:100%!important;height:auto!important;object-fit:contain}'
    + 'html.scene .scene-figure{box-sizing:border-box;display:flex;align-items:center;justify-content:center;width:100%;min-height:0;margin:0;padding:12px;border-radius:28px;background:#f4f1e8}'
    + 'html.scene .scene-figure img{margin:0 auto}';
  const prefs = { theme: 'light', size: 120, flow: 'scrolled-doc', rate: 1, auto: true, ...JSON.parse(localStorage.getItem('prefs') || '{}') };
  let book, rendition, bookId, opener;

  const savePrefs = () => localStorage.setItem('prefs', JSON.stringify(prefs));
  const announce = t => { $('#r-live').textContent = t; };

  function styleContents(c) {
    let st = c.document.getElementById('rt-style');
    if (!st) { st = c.document.createElement('style'); st.id = 'rt-style'; c.document.head.append(st); }
    st.textContent = HL_CSS + FIT_CSS;   // los colores los pone el tema nativo, aquí sólo resaltado y maquetación
    const stationHeading = [...c.document.querySelectorAll('h1')].find(heading => /^Estación\s+\d+$/i.test(heading.textContent.trim()));
    if (stationHeading) {
      c.document.querySelectorAll('.station-label').forEach(label => {
        if (label.textContent.trim().toLowerCase() === stationHeading.textContent.trim().toLowerCase()) {
          label.setAttribute('aria-hidden', 'true');
        }
      });
    }
    if (!c.document.documentElement.dataset.readerGuards) {
      c.document.documentElement.dataset.readerGuards = 'true';
      c.document.addEventListener('contextmenu', event => event.preventDefault());
      c.document.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && ['s', 'p'].includes(event.key.toLowerCase())) event.preventDefault();
      }, true);
    }
    fitScene(c);
    Promise.all([...c.document.images].map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; }))).then(() => fitScene(c));
  }
  // Ajusta cada escena (imagen + texto) al alto visible: primero reduce el texto, luego la imagen.
  function fitScene(c) {
    try {
      const d = c.document, de = d.documentElement, v = $('#viewer'), rh = v.clientHeight;
      if (!rh) return;
      de.style.setProperty('--rh', rh + 'px');
      const seg = d.querySelector('.read-along-segment'), img = d.querySelector('.scene-figure img');
      de.classList.toggle('scene', !!(seg && img));
      if (!seg || !img) return;
      const target = 29.3 * prefs.size / 120, min = prefs.size > 120 ? target : Math.min(14, target);
      const rw = v.clientWidth;
      for (let px = target; px >= min; px -= 1) {
        seg.style.fontSize = px + 'px';
        for (let step = 11; step >= 0; step -= 1) {
          img.style.setProperty('max-height', `${rh * step / 25}px`, 'important');
          if (de.scrollHeight <= rh + 1 && de.scrollWidth <= rw + 1) return;
        }
      }
    } catch (e) { console.warn('fitScene', e); }
  }
  const refit = () => { try { rendition?.getContents().forEach(fitScene); } catch {} };
  function canReadHref(href) {
    if (!previewOnly || Auth.isSubscriber) return true;
    if (previewBoundary < 0) return false;
    const target = decodeURIComponent(String(href).split('#')[0]);
    const index = book?.spine.items.findIndex(item =>
      decodeURIComponent(item.href) === target || target.endsWith('/' + decodeURIComponent(item.href)));
    return index >= 0 && index <= previewBoundary;
  }
  function showPaywall() {
    Voice.pause();
    if (!paywall.open) paywall.showModal();
  }
  function navigateTo(href) {
    if (!canReadHref(href)) return showPaywall();
    rendition.display(href).catch(error => console.error('[Navegación EPUB]', error));
  }
  function applyTheme(name) {
    prefs.theme = name; dlg.dataset.theme = name; savePrefs();
    document.querySelectorAll('.sw').forEach(s => s.setAttribute('aria-checked', s.dataset.theme === name));
    if (rendition) selectTheme(name);
  }
  // epub.js crea su gestor de vistas de forma asíncrona: si select() llega antes, se reintenta al arrancar.
  function selectTheme(name) {
    try { rendition.themes.select(name); }
    catch { rendition.started?.then(() => rendition.themes.select(name)).catch(e => console.warn('themes.select', e)); }
  }
  function applySize(delta) {
    prefs.size = Math.min(220, Math.max(80, prefs.size + delta)); savePrefs();
    rendition?.themes.fontSize(prefs.size + '%'); refit(); announce(`Tamaño de letra ${prefs.size} %`);
  }
  const flowLabel = () => {
    const pag = prefs.flow === 'paginated';
    btnFlow.textContent = pag ? 'Vista: páginas' : 'Vista: desplazar';
    btnFlow.setAttribute('aria-label', `Cambiar modo de vista. Actual: ${pag ? 'páginas' : 'desplazamiento vertical'}`);
  };
  async function toggleFlow() {
    if (!rendition) return;
    let cfi; try { cfi = rendition.currentLocation()?.start?.cfi; } catch {}
    prefs.flow = prefs.flow === 'paginated' ? 'scrolled-doc' : 'paginated'; savePrefs(); flowLabel();
    rendition.flow(prefs.flow); await rendition.display(cfi);
    announce(prefs.flow === 'paginated' ? 'Vista por páginas' : 'Vista de desplazamiento vertical');
  }

  function buildToc(items) {
    const sceneEntries = [];
    const list = its => {
      const ol = document.createElement('ol');
      its.forEach(it => {
        const li = document.createElement('li'), b = document.createElement('button');
        b.textContent = it.label.trim(); b.dataset.href = it.href;
        if (/escena\s+\d+/i.test(it.label)) sceneEntries.push(it);
        b.onclick = () => {
          navigateTo(it.href);
          if (matchMedia('(max-width:720px)').matches) toggleToc(false);
        };
        li.append(b);
        if (it.subitems?.length) li.append(list(it.subitems));
        ol.append(li);
      });
      return ol;
    };
    tocEl.replaceChildren(list(items));
    return sceneEntries;
  }
  function configurePreview(sceneEntries) {
    const entries = sceneEntries.length
      ? sceneEntries
      : book.spine.items.slice(0, previewSceneLimit).map(item => ({ href: item.href }));
    const permitted = entries.slice(0, previewSceneLimit);
    previewStartHref = permitted[0]?.href || book.spine.items[0]?.href || null;
    const finalHref = permitted.at(-1)?.href;
    const target = finalHref && decodeURIComponent(finalHref.split('#')[0]);
    const boundary = target
      ? book.spine.items.findIndex(item => decodeURIComponent(item.href) === target
        || target.endsWith('/' + decodeURIComponent(item.href)))
      : -1;
    previewBoundary = boundary >= 0 ? boundary : Math.min(book.spine.items.length, previewSceneLimit) - 1;
  }
  function toggleToc(show = tocEl.hidden) {
    tocEl.hidden = !show; btnToc.setAttribute('aria-expanded', String(show));
    if (show) tocEl.querySelector('button')?.focus(); else btnToc.focus();
    rendition?.resize();
  }
  function onKey(e) {
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault?.(); rendition.next(); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault?.(); rendition.prev(); }
  }
  function updateProgress(loc) {
    const p = book.locations.length() ? book.locations.percentageFromCfi(loc.start.cfi) : (loc.start.percentage || 0);
    const pct = Math.round((p || 0) * 100);
    $('#bar-fill').style.width = pct + '%';
    $('#progress').setAttribute('aria-valuenow', pct);
    $('#pct').textContent = pct + ' %';
    localStorage.setItem('pos:' + bookId, loc.start.cfi);
    tocEl.querySelectorAll('button').forEach(b => b.removeAttribute('aria-current'));
    [...tocEl.querySelectorAll('button')].find(b => b.dataset.href?.split('#')[0] === loc.start.href)?.setAttribute('aria-current', 'true');
  }

  async function open(rec, trigger) {
    if (!rec) return;
    previewOnly = !rec.free && !Auth.isSubscriber;
    opener = trigger; bookId = rec.id;
    previewBoundary = -1; previewStartHref = null; lastAllowedCfi = null; restoringPreview = false;
    $('#r-title').textContent = rec.title;
    dlg.setAttribute('aria-label', 'Lector: ' + rec.title);
    if (!dlg.open) dlg.showModal();
    applyTheme(prefs.theme); flowLabel();
    tocEl.hidden = true; btnToc.setAttribute('aria-expanded', 'false');
    $('#bar-fill').style.width = '0'; $('#pct').textContent = '0 %';
    try {
      await ensureEpubJs();
      let temporaryBlob = rec.file;
      if (!(temporaryBlob instanceof Blob)) {
        const response = await fetch(rec.src);
        if (!response.ok) throw new Error(`No se pudo cargar el cuento (${response.status}).`);
        temporaryBlob = await response.blob();
      }
      const buf = await temporaryBlob.arrayBuffer();
      book = ePub(buf, { openAs: 'binary' });
      await book.opened;
      rendition = book.renderTo('viewer', { width: '100%', height: '100%', flow: prefs.flow, spread: 'none' });
      rendition.hooks.content.register(styleContents);
      Object.entries(THEMES).forEach(([name, rules]) => rendition.themes.register(name, rules));
      selectTheme(prefs.theme);
      rendition.themes.fontSize(prefs.size + '%');
      rendition.on('keyup', onKey);
      Voice.attach({
        rendition, book, prefs, flow: () => prefs.flow,
        canRead: canReadHref, onPaywall: showPaywall,
        save: (r, a) => { prefs.rate = +r; prefs.auto = a; savePrefs(); },
      });
      const navigation = await book.loaded.navigation;
      configurePreview(buildToc(navigation.toc));
      rendition.on('relocated', loc => {
        if (!canReadHref(loc.start.href)) {
          Voice.pause();
          showPaywall();
          if (!restoringPreview && lastAllowedCfi) {
            restoringPreview = true;
            rendition.display(lastAllowedCfi)
              .catch(error => console.error('[Vista previa]', error))
              .finally(() => { restoringPreview = false; });
          }
          return;
        }
        lastAllowedCfi = loc.start.cfi;
        Voice.onRelocated(loc);
        updateProgress(loc);
      });
      loadOverlays(buf).then(m => Voice.setOverlays(m)).catch(e => console.warn('Sin narración SMIL:', e));
      const saved = previewOnly ? null : localStorage.getItem('pos:' + rec.id);
      try { await rendition.display(saved || (previewOnly ? previewStartHref : undefined) || undefined); }
      catch (e) { console.warn('Posición guardada inválida', e); await rendition.display(); }
      Voice.refresh();
      book.ready.then(() => book.locations.generate(1200)).then(() => {
        const l = rendition.currentLocation(); if (l?.start) updateProgress(l);
      }).catch(e => console.warn('Sin cálculo de progreso:', e));
    } catch (e) {
      console.error('[Lector EPUB]', e);
      close();
      $('#catalog-status').textContent = `No se pudo abrir «${rec.title}»: ${e?.message || e}`;
      $('#catalog-status').classList.add('err');
    }
  }
  function close() {
    Voice.reset();   // OBLIGATORIO al cerrar: detiene audio/TTS y revoca las URLs de audio
    if (paywall.open) paywall.close();
    if (dlg.open) dlg.close();
    rendition?.destroy(); book?.destroy(); rendition = book = null;
    previewOnly = false; previewBoundary = -1;
    opener?.focus();
  }
  function init() {
    restoreAuth(); updateUserStatus();
    $('#btn-plans').addEventListener('click', () => openAccessDialog('plans'));
    $('#btn-login').addEventListener('click', () => openAccessDialog('login'));
    $('#paywall-plans').addEventListener('click', () => {
      paywall.close();
      openAccessDialog('paywall');
    });
    $('#paywall-close').addEventListener('click', () => paywall.close());
    $('#activation-form').addEventListener('submit', event => {
      event.preventDefault();
      const field = $('#activation-code');
      const status = $('#access-status');
      if (!Auth.activate(field.value)) {
        field.setAttribute('aria-invalid', 'true');
        status.textContent = 'El código ingresado no es válido. Revísalo e inténtalo nuevamente.';
        status.classList.add('err');
        return;
      }
      field.removeAttribute('aria-invalid');
      field.value = '';
      status.textContent = 'Acceso activado.';
      status.classList.remove('err');
      updateUserStatus();
      Gallery.render();
      if (paywall.open) paywall.close();
      $('#modal-auth').close();
    });
    $('#activation-code').addEventListener('input', event => {
      event.currentTarget.removeAttribute('aria-invalid');
      $('#access-status').textContent = '';
      $('#access-status').classList.remove('err');
    });
    document.addEventListener('contextmenu', event => { if (dlg.open) event.preventDefault(); });
    document.addEventListener('keydown', event => {
      if (dlg.open && (event.ctrlKey || event.metaKey) && ['s', 'p'].includes(event.key.toLowerCase())) event.preventDefault();
    }, true);
    $('#next').onclick = () => rendition?.next();
    $('#prev').onclick = () => rendition?.prev();
    $('#font-inc').onclick = () => applySize(10);
    $('#font-dec').onclick = () => applySize(-10);
    $('#btn-close').onclick = close;
    btnToc.onclick = () => toggleToc();
    btnFlow.onclick = toggleFlow;
    let t; new ResizeObserver(() => { clearTimeout(t); t = setTimeout(refit, 120); }).observe($('#viewer'));
    document.querySelectorAll('.sw').forEach(s => s.onclick = () => applyTheme(s.dataset.theme));
    dlg.addEventListener('cancel', e => { e.preventDefault(); close(); });
    dlg.addEventListener('keydown', e => { if (e.target.closest('.r-bar,.r-audio,.toc')) return; onKey(e); });
  }
  return { init, open };
})();

/* ========== Arranque ========== */
document.addEventListener('DOMContentLoaded', () => {
  initCarousel();
  initMediaTabs();
  Reader.init();
  Gallery.init().catch(error => {
    console.error('[Catálogo]', error);
    const status = $('#catalog-status');
    status.textContent = `No se pudo cargar el catálogo: ${error?.message || error}`;
    status.classList.add('err');
  });
});