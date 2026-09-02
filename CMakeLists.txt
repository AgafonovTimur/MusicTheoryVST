cmake_minimum_required(VERSION 3.22)

project(MusicTheoryVST VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ---- JUCE скачивается автоматически при сборке ----
include(FetchContent)

FetchContent_Declare(JUCE
    GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
    GIT_TAG        8.0.8
    GIT_SHALLOW    TRUE)

FetchContent_MakeAvailable(JUCE)

# ---- Плагин ----
# NEEDS_WEBVIEW2 — окно плагина рисует встроенный браузер Edge (WebView2).
# Для сборки нужен пакет Microsoft.Web.WebView2, его скачивает workflow
# (см. .github/workflows/build.yml). Готовому плагину пакет не нужен:
# библиотека линкуется внутрь, а сам браузер уже есть в Windows.
juce_add_plugin(MusicTheoryVST
    COMPANY_NAME              "MusicTheoryVST"
    BUNDLE_ID                 "com.musictheoryvst.plugin"
    IS_SYNTH                  TRUE
    NEEDS_MIDI_INPUT          TRUE
    NEEDS_MIDI_OUTPUT         TRUE
    IS_MIDI_EFFECT            FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS TRUE
    COPY_PLUGIN_AFTER_BUILD   FALSE
    NEEDS_WEBVIEW2            TRUE
    PLUGIN_MANUFACTURER_CODE  Mthr
    PLUGIN_CODE               Mth1
    FORMATS                   VST3
    VST3_CATEGORIES           "Instrument" "Tools"
    PRODUCT_NAME              "Music Theory VST")

# ---- Приложения вшиваются в плагин ----
# Файлы приложений лежат здесь ровно в том виде, в каком работают в
# браузере. Чтобы обновить приложение, достаточно заменить файл и
# пересобрать — переименовывать ничего нельзя, имена ищутся из кода.
juce_add_binary_data(MusicTheoryVSTData
    SOURCES
        Resources/index.html
        Resources/circle_of_fifths.html
        Resources/note-trainer.html
        Resources/ear-trainer.html
        Resources/plugin-bridge.js)

target_sources(MusicTheoryVST PRIVATE
    Source/PluginProcessor.cpp
    Source/PluginEditor.cpp)

target_compile_definitions(MusicTheoryVST PUBLIC
    JUCE_WEB_BROWSER=1
    JUCE_USE_WIN_WEBVIEW2_WITH_STATIC_LINKING=1
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0)

target_link_libraries(MusicTheoryVST
    PRIVATE
        MusicTheoryVSTData
        juce::juce_audio_utils
        juce::juce_gui_extra
    PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_lto_flags
        juce::juce_recommended_warning_flags)

# Исходники в UTF-8 (иначе MSVC ломает русский текст в комментариях)
if(MSVC)
    target_compile_options(MusicTheoryVST PRIVATE /utf-8)
endif()
