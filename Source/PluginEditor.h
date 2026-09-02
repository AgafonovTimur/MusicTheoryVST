#pragma once

#include <juce_gui_extra/juce_gui_extra.h>
#include "PluginProcessor.h"

//==============================================================================
//  Окно плагина. Внутри — встроенный браузер (WebView2), в нём открыты
//  index.html и три приложения; все файлы вшиты в плагин и отдаются из
//  памяти (см. provideResource в PluginEditor.cpp).
//==============================================================================
class MusicTheoryEditor : public juce::AudioProcessorEditor,
                          private juce::Timer
{
public:
    explicit MusicTheoryEditor (MusicTheoryProcessor&);
    ~MusicTheoryEditor() override;

    void paint (juce::Graphics&) override;
    void resized() override;

private:
    void timerCallback() override;

    juce::WebBrowserComponent::Options createOptions();

    void handleMidiFromWeb (const juce::var& payload);
    void handleStorageFromWeb (const juce::var& payload);

    MusicTheoryProcessor& processor;
    juce::WebBrowserComponent webView;

    int lastStorageRevision = 0;

    // Пока окно не построено до конца, его размер в настройки не пишется:
    // ограничения размера успевают затереть сохранённое значение
    bool ready = false;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MusicTheoryEditor)
};
