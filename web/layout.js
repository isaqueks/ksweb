/*
 * layout.js — disposição da IDE: splitters arrastáveis (mouse, toque e
 * setas do teclado), painéis recolhíveis (explorador, depurador e painel
 * inferior, que recolhe até a barra de abas), abas do painel inferior e da
 * coluna direita (Depurador | Ajuda) e o estado salvo no localStorage
 * ("ksweb-ide:layout").
 *
 *   const lay = new KsLayout({onChange(state), onPanel(name), onRight(name)});
 *   lay.showPanel('terminal' | 'problems' | 'output' | 'disasm' | 'reference')
 *   lay.showRight('debugger' | 'help') / lay.rightTab
 *   lay.collapse('left' | 'right' | 'bottom', on?)   (on omitido = alterna)
 *   lay.ensureBottom(px)   painel inferior com pelo menos px de altura
 *   lay.isOpen('right')
 */
(function (root) {
  'use strict';

  const KEY = 'ksweb-ide:layout';
  const MIN = { left: 120, right: 220, bottom: 90 };
  const DEF = { left: 210, right: 420, bottom: 300, no: { left: false, right: false, bottom: false }, panel: 'terminal', rtab: 'debugger' };
  const RIGHT_TABS = ['debugger', 'help'];

  /* Estado salvo, campo a campo: JSON inválido, tipos errados ou valores
   * absurdos (editados à mão, de outra versão) caem no padrão. */
  function load() {
    const st = JSON.parse(JSON.stringify(DEF));
    let s = null;
    try { s = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { s = null; }
    if (!s || typeof s !== 'object') return st;
    for (const k of ['left', 'right', 'bottom']) {
      if (typeof s[k] === 'number' && Number.isFinite(s[k])) st[k] = s[k];
      if (s.no && typeof s.no === 'object') st.no[k] = s.no[k] === true;
    }
    if (typeof s.panel === 'string') st.panel = s.panel;
    if (RIGHT_TABS.includes(s.rtab)) st.rtab = s.rtab;
    return st;
  }

  class KsLayout {
    constructor(opts) {
      this.opts = opts || {};
      this.ws = document.getElementById('workspace');
      this.root = document.documentElement;
      this.state = load();
      if (window.innerWidth < 900 && !this._stored()) this.state.no.right = true;
      this._fit();
      this._apply();
      for (const sp of document.querySelectorAll('.splitter')) this._bindSplitter(sp);
      for (const b of document.querySelectorAll('[data-collapse]')) b.addEventListener('click', () => this.collapse(b.dataset.collapse, true));
      for (const b of document.querySelectorAll('[data-expand]')) b.addEventListener('click', () => this.collapse(b.dataset.expand, false));
      for (const t of document.querySelectorAll('.ptabs [role="tab"]')) {
        t.addEventListener('click', () => this.showPanel(t.dataset.panel));
        t.addEventListener('keydown', (e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
          const tabs = [...document.querySelectorAll('.ptabs [role="tab"]')];
          const i = tabs.indexOf(t) + (e.key === 'ArrowRight' ? 1 : -1);
          const n = tabs[(i + tabs.length) % tabs.length];
          n.focus();
          this.showPanel(n.dataset.panel);
        });
      }
      const rtabs = [...document.querySelectorAll('.rtabs [role="tab"]')];
      for (const t of rtabs) {
        t.addEventListener('click', () => this.showRight(t.dataset.right));
        t.addEventListener('keydown', (e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
          const n = rtabs[(rtabs.indexOf(t) + (e.key === 'ArrowRight' ? 1 : -1) + rtabs.length) % rtabs.length];
          n.focus();
          this.showRight(n.dataset.right);
        });
      }
      this.showPanel(this.state.panel, true);
      this.showRight(this.state.rtab, true);
    }

    get rightTab() { return this.state.rtab; }

    /* Aba da coluna direita; abre a coluna se estava recolhida (exceto na
     * restauração do estado salvo). */
    showRight(name, initial) {
      if (!RIGHT_TABS.includes(name)) name = 'debugger';
      this.state.rtab = name;
      for (const t of document.querySelectorAll('.rtabs [role="tab"]')) {
        const on = t.dataset.right === name;
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.tabIndex = on ? 0 : -1;
      }
      for (const p of document.querySelectorAll('.rpanel')) p.hidden = p.dataset.right !== name;
      if (!initial && this.state.no.right) { this.state.no.right = false; this._apply(); }
      this._save();
      if (this.opts.onRight) this.opts.onRight(name);
    }

    ensureBottom(px) {
      if (this.state.bottom >= px) return;
      this._size('bottom', px);
      this._save();
    }

    _save() {
      try { localStorage.setItem(KEY, JSON.stringify(this.state)); } catch (e) { /* sem localStorage */ }
      if (this.opts.onChange) this.opts.onChange(this.state);
    }

    _apply() {
      const s = this.state;
      this.root.style.setProperty('--left-w', s.left + 'px');
      this.root.style.setProperty('--right-w', s.right + 'px');
      this.root.style.setProperty('--bottom-h', s.bottom + 'px');
      for (const k of ['left', 'right', 'bottom']) this.ws.classList.toggle('no-' + k, !!s.no[k]);
      for (const b of document.querySelectorAll('[data-expand]')) b.hidden = !s.no[b.dataset.expand];
      const c = document.querySelector('[data-collapse="bottom"]');
      if (c) {
        c.textContent = s.no.bottom ? '▴' : '▾';
        c.setAttribute('aria-label', s.no.bottom ? 'Mostrar painel' : 'Recolher painel');
        c.title = s.no.bottom ? 'Mostrar' : 'Recolher';
      }
    }

    isOpen(which) { return !this.state.no[which]; }

    collapse(which, on) {
      if (which === 'bottom' && on === true && this.state.no.bottom) on = false;   /* o mesmo botão alterna */
      this.state.no[which] = on === undefined ? !this.state.no[which] : !!on;
      this._apply();
      this._save();
    }

    showPanel(name, initial) {
      if (!document.getElementById('panel-' + name)) name = 'terminal';
      this.state.panel = name;
      for (const t of document.querySelectorAll('.ptabs [role="tab"]')) {
        const on = t.dataset.panel === name;
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.tabIndex = on ? 0 : -1;
      }
      for (const p of document.querySelectorAll('.ppanel')) p.hidden = p.id !== 'panel-' + name;
      if (!initial && this.state.no.bottom) { this.state.no.bottom = false; this._apply(); }
      this._save();
      if (this.opts.onPanel) this.opts.onPanel(name);
    }

    _stored() { try { return localStorage.getItem(KEY) !== null; } catch (e) { return false; } }

    _clamp(which, v) {
      const max = which === 'bottom' ? window.innerHeight - 160 : window.innerWidth * 0.6;
      return Math.round(Math.max(MIN[which], Math.min(max, v)));
    }

    /* Tamanhos salvos numa tela maior não podem esconder o editor nesta. */
    _fit() {
      const s = this.state;
      for (const k of ['left', 'right', 'bottom']) s[k] = this._clamp(k, s[k]);
      const room = window.innerWidth - 320;
      if (s.left + s.right > room) {
        s.right = Math.max(MIN.right, room - s.left);
        s.left = Math.max(MIN.left, room - s.right);
      }
    }

    _size(which, v) {
      this.state[which] = this._clamp(which, v);
      this._apply();
    }

    _bindSplitter(sp) {
      const which = sp.dataset.split;
      let start = null;
      sp.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        sp.setPointerCapture(e.pointerId);
        sp.classList.add('dragging');
        start = { x: e.clientX, y: e.clientY, v: this.state[which] };
      });
      sp.addEventListener('pointermove', (e) => {
        if (!start) return;
        const d = which === 'left' ? e.clientX - start.x : which === 'right' ? start.x - e.clientX : start.y - e.clientY;
        this._size(which, start.v + d);
      });
      const end = () => { if (!start) return; start = null; sp.classList.remove('dragging'); this._save(); };
      sp.addEventListener('pointerup', end);
      sp.addEventListener('pointercancel', end);
      sp.addEventListener('dblclick', () => this.collapse(which, true));
      sp.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 60 : 20;
        let d = 0;
        if (which === 'bottom') { if (e.key === 'ArrowUp') d = step; else if (e.key === 'ArrowDown') d = -step; }
        else if (e.key === 'ArrowLeft') d = which === 'left' ? -step : step;
        else if (e.key === 'ArrowRight') d = which === 'left' ? step : -step;
        if (!d) return;
        e.preventDefault();
        this._size(which, this.state[which] + d);
        this._save();
      });
    }
  }

  root.KsLayout = KsLayout;
})(typeof self !== 'undefined' ? self : this);
