/* =====================================================================
   Music Theory VST — мост между веб-приложениями и плагином.

   Этот скрипт запускает сам плагин (WebBrowserComponent::withUserScript)
   в КАЖДОМ фрейме — и в оболочке index.html, и внутри всех трёх
   приложений — ДО того, как выполнится любой код страницы. Поэтому все
   четыре файла (index.html, circle_of_fifths.html, note-trainer.html,
   ear-trainer.html) кладутся в папку Resources как есть, без правок.

   Что делает мост:
     1) подменяет localStorage — настройки уходят в проект DAW;
     2) подменяет Web MIDI — ноты идут прямо в DAW, LoopMIDI не нужен;
     3) прячет блоки выбора MIDI-портов (в плагине их выбирать не из
        чего) и включает отправку нот в DAW при первом запуске;
     4) подгоняет приложения под окно плагина — во всё окно, без полей.
   ===================================================================== */
(function () {
  'use strict';

  var IS_TOP = false;
  try { IS_TOP = (window.top === window); } catch (e) { IS_TOP = false; }

  /* ---------------------------------------------------------------
     Связь с плагином.

     window.__JUCE__ есть во всех фреймах, но реально доходят до C++
     только сообщения из ГЛАВНОГО фрейма (WebView2 доставляет сообщения
     из iframe отдельным каналом, который JUCE не слушает). Все наши
     фреймы одного происхождения, поэтому из приложений обращаемся к
     объекту главного фрейма — так сообщение отправляет он.
     --------------------------------------------------------------- */
  function topBackend() {
    try {
      if (window.top.__JUCE__ && window.top.__JUCE__.backend) return window.top.__JUCE__.backend;
    } catch (e) {}
    try {
      if (window.__JUCE__ && window.__JUCE__.backend) return window.__JUCE__.backend;
    } catch (e) {}
    return null;
  }

  /* Центр обмена. Создаётся один раз в главном фрейме, приложения
     берут его через window.top.MT_HOST. */
  function createHost() {
    var backend = topBackend();
    var store = {};

    // начальные настройки, переданные плагином при создании окна
    try {
      var packed = window.__JUCE__.initialisationData.mtStorage;
      var json = (packed && packed.length) ? packed[0] : '{}';
      var parsed = JSON.parse(json || '{}');
      if (parsed && typeof parsed === 'object') store = parsed;
    } catch (e) {}

    var midiListeners = [];
    var saveTimer = null;

    function flush() {
      if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
      if (!backend) return;
      try { backend.emitEvent('mtSaveStorage', { json: JSON.stringify(store) }); } catch (e) {}
    }

    var host = {
      store: store,

      // настройки пишутся часто — отправляем пачкой, не чаще чем раз в 400 мс
      save: function () {
        if (saveTimer !== null) return;
        saveTimer = setTimeout(flush, 400);
      },

      // отправить в плагин сразу, если есть что отправлять
      saveNow: function () {
        if (saveTimer !== null) flush();
      },

      /* Приложения сами откладывают запись настроек (до 10 секунд после
         последнего изменения) и дописывают всё сразу при закрытии страницы —
         по событию beforeunload. Окно плагина DAW закрывает без этого
         события, поэтому мост сам подаёт его приложениям: когда мышь уходит
         из окна плагина, окно теряет фокус и раз в несколько секунд.
         Ничего, кроме записи настроек, приложения по beforeunload не делают. */
      flushApps: function () {
        var frames = document.querySelectorAll('iframe');
        for (var i = 0; i < frames.length; i++) {
          try {
            var w = frames[i].contentWindow;
            if (w) w.dispatchEvent(new w.Event('beforeunload'));
          } catch (e) {}
        }
        host.saveNow();
      },

      sendMidi: function (bytes) {
        if (!backend) return;
        try { backend.emitEvent('mtMidiOut', { b: bytes }); } catch (e) {}
      },

      addMidiListener: function (fn) { midiListeners.push(fn); },

      removeMidiListener: function (fn) {
        var i = midiListeners.indexOf(fn);
        if (i !== -1) midiListeners.splice(i, 1);
      }
    };

    if (backend) {
      // ноты из DAW -> во все три приложения
      backend.addEventListener('mtMidiIn', function (msg) {
        if (!msg || !msg.m) return;
        for (var i = 0; i < msg.m.length; i++) {
          var bytes = msg.m[i];
          for (var j = 0; j < midiListeners.length; j++) {
            try { midiListeners[j](bytes); } catch (e) {}
          }
        }
      });

      // проект DAW загрузился уже после открытия окна плагина:
      // забираем настройки и перезагружаем приложения, чтобы они их прочитали
      backend.addEventListener('mtStorage', function (msg) {
        if (!msg || typeof msg.json !== 'string') return;
        var parsed = null;
        try { parsed = JSON.parse(msg.json); } catch (e) { return; }
        if (!parsed || typeof parsed !== 'object') return;

        Object.keys(store).forEach(function (k) { delete store[k]; });
        Object.keys(parsed).forEach(function (k) { store[k] = parsed[k]; });

        var frames = document.querySelectorAll('iframe');
        for (var i = 0; i < frames.length; i++) {
          try { frames[i].contentWindow.location.reload(); } catch (e) {}
        }
      });
    }

    return host;
  }

  var HOST = null;
  if (IS_TOP) {
    HOST = createHost();
    try { window.MT_HOST = HOST; } catch (e) {}
  } else {
    try { HOST = window.top.MT_HOST || null; } catch (e) { HOST = null; }
  }

  /* ---------------------------------------------------------------
     1. localStorage -> состояние плагина (сохраняется в проекте DAW)
     --------------------------------------------------------------- */
  /* Подменённое хранилище должно быть для приложений неотличимо от
     настоящего localStorage. Квинтовый круг и тренажёр нот сами
     подменяют стандартные методы хранилища (Storage.prototype), чтобы
     откладывать запись и держать часть данных только в памяти (история
     ошибок в тренажёре нот). Это срабатывает, только если localStorage
     действительно хранилище, — поэтому наш объект сделан из того же
     прототипа Storage, а стандартные методы для него перенаправлены
     в хранилище плагина. Для любых других хранилищ всё как было. */
  function installStorage() {
    if (!HOST) return;
    var store = HOST.store;
    var has = function (k) { return Object.prototype.hasOwnProperty.call(store, k); };

    var impl = {
      getItem: function (k) {
        k = String(k);
        return has(k) ? store[k] : null;
      },
      setItem: function (k, v) {
        k = String(k); v = String(v);
        if (has(k) && store[k] === v) return;   // то же значение — проект не трогаем
        store[k] = v;
        HOST.save();
      },
      removeItem: function (k) {
        k = String(k);
        if (!has(k)) return;
        delete store[k];
        HOST.save();
      },
      clear: function () {
        var keys = Object.keys(store);
        if (!keys.length) return;
        keys.forEach(function (k) { delete store[k]; });
        HOST.save();
      },
      key: function (i) {
        var keys = Object.keys(store);
        return (i >= 0 && i < keys.length) ? keys[i] : null;
      },
      length: function () { return Object.keys(store).length; }
    };

    var shim = null;

    try {
      if (typeof Storage === 'function' && Storage.prototype) {
        var SP = Storage.prototype;
        shim = Object.create(SP);

        ['getItem', 'setItem', 'removeItem', 'clear', 'key'].forEach(function (name) {
          var original = SP[name];
          SP[name] = function () {
            if (this === shim) return impl[name].apply(null, arguments);
            return original.apply(this, arguments);
          };
        });

        var lengthDesc = Object.getOwnPropertyDescriptor(SP, 'length');
        Object.defineProperty(SP, 'length', {
          configurable: true,
          enumerable: lengthDesc ? lengthDesc.enumerable : true,
          get: function () {
            if (this === shim) return impl.length();
            return lengthDesc && lengthDesc.get ? lengthDesc.get.call(this) : 0;
          }
        });
      }
    } catch (e) { shim = null; }

    // запасной путь — простой объект с теми же методами
    if (!shim) {
      shim = {
        getItem: impl.getItem, setItem: impl.setItem, removeItem: impl.removeItem,
        clear: impl.clear, key: impl.key
      };
      Object.defineProperty(shim, 'length', { get: impl.length });
    }

    try {
      Object.defineProperty(window, 'localStorage', {
        value: shim, configurable: true, writable: false
      });
    } catch (e) {
      // не получилось — остаёмся на обычном localStorage браузера,
      // приложения продолжат работать, но настройки не уйдут в проект
    }
  }

  /* Значения по умолчанию для плагина. Ставятся ТОЛЬКО если ключа ещё
     нет, то есть при первом открытии в новом проекте, и без записи —
     чтобы открытие плагина само по себе не помечало проект изменённым. */
  function seedDefaults() {
    if (!HOST) return;
    var store = HOST.store;

    // Квинтовый круг: отправка нот в DAW включена сразу ("за раз").
    // Без этого приложение стартует в режиме 'off' и ничего не шлёт.
    if (!Object.prototype.hasOwnProperty.call(store, 'circleOfFifths_dawOutMode_v1'))
      store['circleOfFifths_dawOutMode_v1'] = 'together';

    // Квинтовый круг, блок "Сыграть аккорд в": в браузерной версии по
    // умолчанию "Без звука", в плагине — сразу "DAW". Если пользователь
    // потом выберет другое, его выбор сохранится и здесь не перебивается.
    if (!Object.prototype.hasOwnProperty.call(store, 'circleOfFifths_soundOutMode_v1'))
      store['circleOfFifths_soundOutMode_v1'] = 'daw';

    // Тренажёр слуха: запоминаем, есть ли у него уже настройки в проекте.
    // Сами настройки здесь не подставляем — иначе приложение решит, что это
    // не первый запуск, и пропустит своё поведение первого запуска
    // (открыть панель настроек, поставить её по центру).
    EAR_FIRST_RUN = !Object.prototype.hasOwnProperty.call(store, 'earTrainerSettings');
  }

  var EAR_FIRST_RUN = false;

  /* ---------------------------------------------------------------
     2. Web MIDI -> MIDI-вход и выход плагина

     Приложениям видна ровно одна пара портов с именем
     "Music Theory VST". Всё, что они отправляют в выход, уходит в DAW;
     всё, что DAW шлёт в плагин, приходит им как игра на клавиатуре.
     --------------------------------------------------------------- */
  function installMidi() {
    if (!HOST) return;

    function makePort(kind) {
      var port = {
        id: 'mt-' + kind,
        manufacturer: 'Music Theory VST',
        name: 'Music Theory VST',
        version: '1.0',
        type: kind,
        state: 'connected',
        connection: 'open',
        onstatechange: null,
        open: function () { return Promise.resolve(port); },
        close: function () { return Promise.resolve(port); }
      };
      return port;
    }

    var output = makePort('output');
    output.send = function (data) {
      if (!data || !data.length) return;
      var bytes = [];
      for (var i = 0; i < data.length; i++) bytes.push(data[i] & 0xff);
      HOST.sendMidi(bytes);
    };
    output.clear = function () {};

    var input = makePort('input');
    input.onmidimessage = null;

    var extraListeners = [];
    input.addEventListener = function (type, fn) {
      if (type === 'midimessage' && typeof fn === 'function') extraListeners.push(fn);
    };
    input.removeEventListener = function (type, fn) {
      var i = extraListeners.indexOf(fn);
      if (i !== -1) extraListeners.splice(i, 1);
    };

    HOST.addMidiListener(function (bytes) {
      var event = {
        type: 'midimessage',
        data: new Uint8Array(bytes),
        timeStamp: (window.performance && performance.now) ? performance.now() : Date.now(),
        target: input,
        currentTarget: input
      };
      if (typeof input.onmidimessage === 'function') {
        try { input.onmidimessage(event); } catch (e) {}
      }
      for (var i = 0; i < extraListeners.length; i++) {
        try { extraListeners[i](event); } catch (e) {}
      }
    });

    var access = {
      inputs: new Map([[input.id, input]]),
      outputs: new Map([[output.id, output]]),
      sysexEnabled: false,
      onstatechange: null,
      addEventListener: function () {},
      removeEventListener: function () {}
    };

    var request = function () { return Promise.resolve(access); };
    try {
      Object.defineProperty(navigator, 'requestMIDIAccess', {
        value: request, configurable: true, writable: true
      });
    } catch (e) {
      try { navigator.requestMIDIAccess = request; } catch (e2) {}
    }
  }

  /* ---------------------------------------------------------------
     3. Блоки выбора MIDI-портов в настройках

     Элементы не удаляются из страницы, а скрываются: код приложений
     продолжает их находить и работает без изменений.
     --------------------------------------------------------------- */
  function hide(el) {
    if (el && el.style) el.style.setProperty('display', 'none', 'important');
  }

  function hideAll(selector) {
    var list = document.querySelectorAll(selector);
    for (var i = 0; i < list.length; i++) hide(list[i]);
  }

  function hideRowOf(selector, rowSelector) {
    var list = document.querySelectorAll(selector);
    for (var i = 0; i < list.length; i++) {
      var row = list[i].closest(rowSelector);
      hide(row || list[i]);
    }
  }

  /* То, что прятать нельзя ни в коем случае: вывод звука, настройки
     отправки в DAW, кнопки переключения приложений, названия нот. */
  var KEEP_VISIBLE = '.soundOutBox, #dawVelocityInput, #dawIntervalInput, ' +
                     '#dawSplitChannelsCheckbox, #dawPlayTogetherBtn, ' +
                     '[data-switch-level], .noteNamingBtn';

  function containsKept(el) {
    return !!(el && (el.matches(KEEP_VISIBLE) || el.querySelector(KEEP_VISIBLE)));
  }

  /* Квинтовый круг: блок выбора портов ищем от его списка "Количество
     MIDI входов". Если в этом блоке нет ничего нужного — прячем блок
     целиком вместе с его заголовком "MIDI". Если в нём лежат и другие
     настройки (так было в старых версиях) — прячем только строки портов. */
  function hideCirclePortsBox(countSelect) {
    var box = countSelect.closest('.midiPanel');

    if (box && !containsKept(box)) {
      hide(box);
      var title = box.previousElementSibling;
      if (title && title.classList.contains('cofBoxTitle') && title.textContent.trim() === 'MIDI')
        hide(title);
      return;
    }

    var scope = box || document;
    hide(countSelect.closest('.midiPanelRow') || countSelect);

    var parts = scope.querySelectorAll('.midiInputSelectsContainer, .midiStatusLine, .midiReconnectBtn');
    for (var i = 0; i < parts.length; i++) if (!containsKept(parts[i])) hide(parts[i]);

    var outputs = scope.querySelectorAll('.dawOutputSelect');
    for (var j = 0; j < outputs.length; j++) {
      var row = outputs[j].closest('#dawOutPanel') || outputs[j].closest('.midiPanelRow') || outputs[j];
      if (!containsKept(row)) hide(row);
    }
  }

  function hideMidiSettings() {
    // --- Квинтовый круг --- (во всех вкладках: "Обучение", "Ноты", "Аккорды/Лады")
    var countSelects = document.querySelectorAll('.midiInputCountSelect');
    for (var i = 0; i < countSelects.length; i++) hideCirclePortsBox(countSelects[i]);

    // --- Тренажёр нот --- (блок целиком: заголовок, порты, статус, кнопка)
    hideAll('.settings-block.midi-row');

    // --- Тренажёр слуха --- (поле Velocity в этом же блоке оставляем)
    hideRowOf('#midiInputSelect, #midiOutputSelect', '.midiPanelRow');
    hideAll('#connectMidiBtn, #midiStatus');
  }

  /* Подключение MIDI. В браузере это делала кнопка "Подключить MIDI",
     в плагине подключаться не к чему — порт всегда один и тот же,
     поэтому просто нажимаем кнопку за пользователя. */
  function autoConnect() {
    // строго по id: класс .midi-connect-btn в тренажёре нот носит ещё и
    // кнопка "Восстановить настройки по умолчанию", её трогать нельзя
    var button = document.querySelector('#midiReconnectBtn, #midiConnectBtn, #connectMidiBtn');
    if (button) { try { button.click(); } catch (e) {} }
  }

  /* Тренажёр слуха в плагине играет через MIDI в DAW. В браузерной
     версии по умолчанию стоит «Онлайн (звук в браузере)», поэтому при
     первом запуске в проекте нажимаем кнопку «DAW» — так же, как это
     сделал бы пользователь: приложение само переключит поля и сохранит
     выбор. Дальше выбор остаётся за пользователем и не перебивается. */
  function ensureEarDawOutput() {
    if (!EAR_FIRST_RUN) return;
    var dawButton = document.querySelector('#outputSegment [data-output="daw"]');
    if (!dawButton) return;                       // это не тренажёр слуха
    if (dawButton.classList.contains('active')) return;
    try { dawButton.click(); } catch (e) {}
  }

  /* Выполнить fn, когда страница приложения разобрана.

     Важно: iframe сначала создаётся с пустой страницей, и мост может
     запуститься один раз — для неё, а приложение потом загружается в то
     же самое окно. Поэтому ждём событие готовности на ОКНЕ, а не на
     документе: событие от страницы приложения тоже доходит до окна.
     Если сейчас открыта уже готовая страница (та самая пустая) — fn
     выполняется сразу, ей это ничем не мешает, и ещё раз — когда будет
     готова страница приложения. */
  function onReady(fn) {
    if (document.readyState !== 'loading') {
      try { fn(); } catch (e) {}
    }
    window.addEventListener('DOMContentLoaded', function () {
      try { fn(); } catch (e) {}
    });
  }

  /* ---------------------------------------------------------------
     4. Окно плагина (только в оболочке index.html)

     Приложения всегда занимают окно целиком, полей по краям нет. Пока
     окно не меньше 1280x800, масштаб 1:1 и приложения видят настоящий
     размер окна, как в браузере. Если окно меньше — картинка целиком
     уменьшается, а приложение видит окно не меньше 1280x800, поэтому
     ничего не обрезается.

     Масштаб ставится прямо на iframe. Переносить iframe в другой блок
     нельзя: при переносе браузер перезагружает приложение внутри.

     Размер задаётся двумя способами сразу:
       - таблицей стилей документа (adoptedStyleSheets) — она действует
         с первой отрисовки, ещё до появления iframe в странице, так что
         приложение с самого начала видит правильный размер окна;
       - атрибутом style у каждого iframe — запасной путь на случай, если
         таблицы стилей такого вида движок не поддерживает.
     --------------------------------------------------------------- */
  var BASE_W = 1280;
  var BASE_H = 800;
  var layoutSheet = null;

  function computeLayout() {
    var w = window.innerWidth || BASE_W;
    var h = window.innerHeight || BASE_H;
    var scale = Math.min(1, w / BASE_W, h / BASE_H);
    return {
      width:  Math.ceil(w / scale) + 'px',
      height: Math.ceil(h / scale) + 'px',
      transform: scale < 1 ? 'scale(' + scale + ')' : 'none'
    };
  }

  function layoutFrames() {
    // старая оболочка плагина со своей подгонкой (блок #stage) —
    // вторую подгонку поверх не накладываем
    if (document.getElementById('stage')) {
      if (layoutSheet) { try { layoutSheet.replaceSync(''); } catch (e) {} }
      return;
    }

    var L = computeLayout();

    if (layoutSheet) {
      try {
        layoutSheet.replaceSync(
          'iframe{position:absolute!important;top:0!important;left:0!important;' +
          'width:' + L.width + '!important;height:' + L.height + '!important;' +
          'transform-origin:0 0!important;transform:' + L.transform + '!important;}');
      } catch (e) {}
    }

    var frames = document.querySelectorAll('iframe');
    for (var i = 0; i < frames.length; i++) {
      var st = frames[i].style;
      st.setProperty('position', 'absolute', 'important');
      st.setProperty('top', '0', 'important');
      st.setProperty('left', '0', 'important');
      st.setProperty('width', L.width, 'important');
      st.setProperty('height', L.height, 'important');
      st.setProperty('transform-origin', '0 0', 'important');
      st.setProperty('transform', L.transform, 'important');
    }
  }

  function installSaveTriggers() {
    if (!HOST) return;
    var request = function () { try { HOST.flushApps(); } catch (e) {} };

    // в каждом фрейме: мышь ушла из окна плагина, окно потеряло фокус
    window.addEventListener('blur', request);
    window.addEventListener('mouseout', function (e) {
      if (!e.relatedTarget) request();     // ушла не на другой элемент, а за пределы окна
    });

    // и на всякий случай раз в 5 секунд (если ничего не менялось — ничего не отправится)
    if (IS_TOP) setInterval(request, 5000);
  }

  function installLayout() {
    if (!IS_TOP) return;

    try {
      if ('adoptedStyleSheets' in document && typeof CSSStyleSheet === 'function') {
        layoutSheet = new CSSStyleSheet();
        document.adoptedStyleSheets = document.adoptedStyleSheets.concat([layoutSheet]);
        layoutFrames();
      }
    } catch (e) { layoutSheet = null; }

    // Подгоняем каждый iframe сразу, как только он появился в странице, —
    // до того как приложение внутри успело измерить своё окно.
    var observer = null;
    try {
      observer = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var added = mutations[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var node = added[j];
            if (node.nodeName === 'IFRAME' ||
                (node.querySelector && node.querySelector('iframe'))) {
              layoutFrames();
              return;
            }
          }
        }
      });
      observer.observe(document, { childList: true, subtree: true });
    } catch (e) {}

    onReady(function () {
      layoutFrames();
      if (observer) observer.disconnect();
    });
    window.addEventListener('resize', layoutFrames);
  }

  /* ---------------------------------------------------------------
     Запуск
     --------------------------------------------------------------- */
  installStorage();
  seedDefaults();
  installMidi();
  installLayout();
  installSaveTriggers();

  onReady(function () {
    hideMidiSettings();
    // приложения вешают обработчики в скриптах в конце страницы —
    // даём им долистать до конца и только потом "нажимаем" кнопку
    setTimeout(function () { hideMidiSettings(); autoConnect(); ensureEarDawOutput(); }, 60);
    setTimeout(function () { autoConnect(); ensureEarDawOutput(); }, 400);
  });

  // Контекстное меню браузера в окне плагина не нужно
  window.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  // Ctrl+колесо иначе меняет масштаб самого браузера и ломает раскладку
  window.addEventListener('wheel', function (e) {
    if (e.ctrlKey) e.preventDefault();
  }, { passive: false });
})();
