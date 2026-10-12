/**
 * tutorial_diagram.js — Schema della Battaglia nel tutorial, condiviso da
 * desktop e mobile.
 *
 * Disegna dentro il pannello del tutorial lo schema descritto dal server
 * (step.battle_diagram, vedi engine/tutorial.py), in ordine cronologico, ogni parte
 * con prima la sua regola e poi l'esempio:
 * 1. il Danno: i valori dei due lati (i più alti di ciascuno) con la carta da
 *    cui vengono, gli scontri
 *    (ATT contro DIF, GIT contro GIT) con quanto passa, e la somma;
 * 2. dove va il Danno: prima i Muri, poi la Vita.
 * I rombi riprendono quelli delle Caratteristiche sulle carte. Lo stile è nel
 * CSS di ciascun client (.bd-*).
 */

const TutorialDiagram = (() => {
  function _el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function _dia(value, cls) {
    const d = _el('span', `bd-dia ${cls || ''}`);
    d.appendChild(_el('b', '', value));
    return d;
  }

  function _side(side) {
    const box = _el('div', 'bd-side');
    box.appendChild(_el('div', 'bd-title', side.title));
    box.appendChild(_el('div', 'bd-sub', side.sub));
    side.stats.forEach(([stat, value, from]) => {
      const row = _el('div', 'bd-stat');
      row.appendChild(_dia(value));
      const label = _el('span', 'bd-label');
      label.appendChild(_el('b', '', stat));
      label.appendChild(_el('span', 'bd-from', from));
      row.appendChild(label);
      box.appendChild(row);
    });
    return box;
  }

  function render(diagram) {
    const root = _el('div', 'bd');

    // 1. Il Danno
    root.appendChild(_el('div', 'bd-head', '1 · Il Danno'));
    const sides = _el('div', 'bd-sides');
    diagram.sides.forEach(side => sides.appendChild(_side(side)));
    root.appendChild(sides);

    const clashes = _el('div', 'bd-rows');
    diagram.clashes.forEach(([a, av, d, dv, pass]) => {
      const row = _el('div', 'bd-row');
      row.appendChild(_el('span', '', `${a} ${av}`));
      row.appendChild(_el('span', 'bd-vs', 'contro'));
      row.appendChild(_el('span', '', `${d} ${dv}`));
      row.appendChild(_el('span', 'bd-arrow', '→'));
      row.appendChild(_el('span', `bd-pass${pass > 0 ? '' : ' none'}`, pass > 0 ? `passa ${pass}` : 'fermato'));
      clashes.appendChild(row);
    });
    root.appendChild(clashes);

    const total = _el('div', 'bd-total');
    total.appendChild(_el('span', '', `${diagram.clashes.map(c => c[4]).join(' + ')} =`));
    total.appendChild(_dia(diagram.damage, 'gold'));
    total.appendChild(_el('span', '', 'Danni'));
    root.appendChild(total);

    // 2. Dove va il Danno: prima i Muri, poi la Vita
    root.appendChild(_el('div', 'bd-head', '2 · Dove va il Danno'));
    root.appendChild(_el('div', 'bd-sub', diagram.split_rule));
    const split = _el('div', 'bd-rows');
    diagram.split.forEach(([from, to]) => {
      const row = _el('div', 'bd-row');
      row.appendChild(_el('span', '', from));
      row.appendChild(_el('span', 'bd-arrow', '→'));
      row.appendChild(_el('span', 'bd-pass', to));
      split.appendChild(row);
    });
    root.appendChild(split);
    return root;
  }

  return { render };
})();
