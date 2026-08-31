// Disposition du clavier SURMEN GS98 (format compact 98 touches, QWERTY ANSI)
// Unités : 1u = largeur d'une touche standard. x/y en u, w/h en u.
// Chargeable côté main (require) et côté renderer (balise <script>).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SATELLA_LAYOUT = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  function row(y, x0, keys) {
    const out = [];
    let x = x0;
    for (const k of keys) {
      const [id, label, w] = k;
      out.push({ id, label, x, y, w: w || 1, h: 1 });
      x += (w || 1);
    }
    return out;
  }

  const NP_X = 15.5; // colonne du pavé numérique

  const keyboard = [].concat(
    row(0, 0, [
      ['esc', 'Esc'], ['f1', 'F1'], ['f2', 'F2'], ['f3', 'F3'], ['f4', 'F4'],
      ['f5', 'F5'], ['f6', 'F6'], ['f7', 'F7'], ['f8', 'F8'], ['f9', 'F9'],
      ['f10', 'F10'], ['f11', 'F11'], ['f12', 'F12'], ['insert', 'Ins'], ['printscreen', 'PrtSc'],
    ]),
    row(0, NP_X, [['delete', 'Del'], ['end', 'End'], ['pageup', 'Pg↑'], ['pagedown', 'Pg↓']]),

    row(1, 0, [
      ['grave', '`'], ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5'],
      ['6', '6'], ['7', '7'], ['8', '8'], ['9', '9'], ['0', '0'], ['minus', '-'],
      ['equal', '='], ['backspace', 'Back', 2],
    ]),
    row(1, NP_X, [['numlock', 'Num'], ['npdivide', '/'], ['npmultiply', '*'], ['npsubtract', '-']]),

    row(2, 0, [
      ['tab', 'Tab', 1.5], ['q', 'Q'], ['w', 'W'], ['e', 'E'], ['r', 'R'], ['t', 'T'],
      ['y', 'Y'], ['u', 'U'], ['i', 'I'], ['o', 'O'], ['p', 'P'],
      ['lbracket', '['], ['rbracket', ']'], ['backslash', '\\', 1.5],
    ]),
    row(2, NP_X, [['np7', '7'], ['np8', '8'], ['np9', '9']]),

    row(3, 0, [
      ['capslock', 'Caps', 1.75], ['a', 'A'], ['s', 'S'], ['d', 'D'], ['f', 'F'],
      ['g', 'G'], ['h', 'H'], ['j', 'J'], ['k', 'K'], ['l', 'L'],
      ['semicolon', ';'], ['quote', "'"], ['enter', 'Enter', 2.25],
    ]),
    row(3, NP_X, [['np4', '4'], ['np5', '5'], ['np6', '6']]),

    row(4, 0, [
      ['lshift', 'Shift', 2.25], ['z', 'Z'], ['x', 'X'], ['c', 'C'],
      ['v', 'V'], ['b', 'B'], ['n', 'N'], ['m', 'M'], ['comma', ','],
      ['period', '.'], ['slash', '/'], ['rshift', 'Shift', 1.75], ['up', '↑'],
    ]),
    row(4, NP_X, [['np1', '1'], ['np2', '2'], ['np3', '3']]),

    row(5, 0, [
      ['lctrl', 'Ctrl', 1.25], ['lwin', 'Win', 1.25], ['lalt', 'Alt', 1.25],
      ['space', '', 5.25], ['ralt', 'Alt'], ['fn', 'Fn'], ['rctrl', 'Ctrl'],
      ['left', '←'], ['down', '↓'], ['right', '→'],
    ]),
    row(5, NP_X, [['np0', '0', 2], ['npdecimal', '.']]),
    [
      { id: 'npadd', label: '+', x: NP_X + 3, y: 2, w: 1, h: 2 },
      { id: 'npenter', label: 'Ent', x: NP_X + 3, y: 4, w: 1, h: 2 },
    ]
  );

  // Zones lumineuses de la souris Risophy PC365A
  const mouse = [
    { id: 'wheel', label: 'Molette' },
    { id: 'logo', label: 'Logo' },
    { id: 'strip_left', label: 'Bande gauche' },
    { id: 'strip_right', label: 'Bande droite' },
    { id: 'strip_bottom', label: 'Bande arrière' },
  ];

  const bounds = { w: 19.5, h: 6 };

  return { keyboard, mouse, bounds };
});
