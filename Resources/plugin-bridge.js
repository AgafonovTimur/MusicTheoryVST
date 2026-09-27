/* =====================================================================
   Music Theory VST — мост между веб-приложениями и плагином.

   Этот скрипт запускает сам плагин (WebBrowserComponent::withUserScript)
   в КАЖДОМ фрейме — и в оболочке index.html, и внутри всех трёх
   приложений — ДО того, как выполнится любой код страницы. Поэтому сами
   файлы приложений (circle_of_fifths.html, note-trainer.html,
   ear-trainer.html) остались без единой правки: их можно обновлять,
   просто заменяя файл в папке Resources.

   Что делает мост:
     1) подменяет localStorage — настройки уходят в проект DAW;
     2) подменяет Web MIDI — ноты идут прямо в DAW, LoopMIDI не нужен;
     3) прячет блоки выбора MIDI-портов (в плагине их выбирать не из
        чего) и включает отправку нот в DAW при первом запуске.
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
      saveTimer = null;
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
  function installStorage() {
    if (!HOST) return;
    var store = HOST.store;

    var shim = {
      getItem: function (k) {
        k = String(k);
        return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
      },
      setItem: function (k, v) {
        store[String(k)] = String(v);
        HOST.save();
      },
      removeItem: function (k) {
        delete store[String(k)];
        HOST.save();
      },
      clear: function () {
        Object.keys(store).forEach(function (k) { delete store[k]; });
        HOST.save();
      },
      key: function (i) {
        var keys = Object.keys(store);
        return (i >= 0 && i < keys.length) ? keys[i] : null;
      }
    };
    Object.defineProperty(shim, 'length', {
      get: function () { return Object.keys(store).length; }
    });

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

  function hideMidiSettings() {
    // --- Квинтовый круг ---
    // Панели во вкладках "Обучение" и "Аккорды/Лады" целиком про MIDI
    hideAll('#notesMidiPanel, #l3MidiPanel');
    // В главной панели прячем только строки портов: настройки отправки
    // в DAW (velocity, интервал, формат, "Разделить сигнал на каналы")
    // остаются на месте
    hideRowOf('#midiInputCountSelect', '.midiPanelRow');
    hideAll('#midiInputSelectsContainer, #dawOutPanel, #midiStatusLine, #midiReconnectBtn');

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

  function onReady(fn) {
    if (document.readyState === 'loading')
      document.addEventListener('DOMContentLoaded', fn);
    else
      fn();
  }

  /* ---------------------------------------------------------------
     Запуск
     --------------------------------------------------------------- */
  installStorage();
  seedDefaults();
  installMidi();

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
