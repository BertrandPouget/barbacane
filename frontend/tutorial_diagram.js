/**
 * tutorial_diagram.js — Schema della Battaglia nel tutorial, condiviso da
 * desktop e mobile.
 *
 * Disegna dentro il pannello del tutorial lo schema descritto dal server
 * (step.diagram, vedi engine/tutorial.py): i valori dei due lati con la carta
 * da cui vengono, gli scontri (ATT contro DIF, GIT contro GIT) con quanto
 * passa, e il risultato su Danni, Muri e Vite. I rombi riprendono quelli delle
 * Caratteristiche sulle carte. Lo stile è nel CSS di ciascun client (.bd-*).
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

    const sides = _el('div', 'bd-sides');
    diagram.sides.forEach(side => sides.appendChild(_side(side)));
    root.appendChild(sides);

    // Scontri: valore contro valore, e quanto passa come Danno
    const clashes = _el('div', 'bd-clashes');
    diagram.clashes.forEach(([a, av, d, dv, pass]) => {
      const row = _el('div', 'bd-clash');
      row.appendChild(_el('span', 'bd-vs-side', `${a} ${av}`));
      row.appendChild(_el('span', 'bd-vs', 'contro'));
      row.appendChild(_el('span', 'bd-vs-side', `${d} ${dv}`));
      row.appendChild(_el('span', 'bd-arrow', '→'));
      row.appendChild(_el('span', `bd-pass${pass > 0 ? '' : ' none'}`, pass > 0 ? `passa ${pass}` : 'fermato'));
      clashes.appendChild(row);
    });
    root.appendChild(clashes);

    // Risultato: Danni contro Muri e Vite
    const result = _el('div', 'bd-result');
    diagram.result.forEach(([label, value], i) => {
      if (i > 0) result.appendChild(_el('span', 'bd-arrow', '→'));
      const cell = _el('span', 'bd-cell');
      cell.appendChild(_dia(value, i === 0 ? 'gold' : ''));
      cell.appendChild(_el('span', 'bd-cell-label', label));
      result.appendChild(cell);
    });
    root.appendChild(result);
    root.appendChild(_el('div', 'bd-outcome', diagram.outcome));
    return root;
  }

  return { render };
})();
