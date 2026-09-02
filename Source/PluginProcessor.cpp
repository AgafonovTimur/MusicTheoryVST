#include "PluginProcessor.h"
#include "PluginEditor.h"

//==============================================================================
MusicTheoryProcessor::MusicTheoryProcessor()
    : AudioProcessor (BusesProperties()
                        .withOutput ("Output", juce::AudioChannelSet::stereo(), true))
{
}

void MusicTheoryProcessor::prepareToPlay (double, int)
{
}

bool MusicTheoryProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    const auto out = layouts.getMainOutputChannelSet();

    return out == juce::AudioChannelSet::stereo()
        || out == juce::AudioChannelSet::mono();
}

//==============================================================================
void MusicTheoryProcessor::processBlock (juce::AudioBuffer<float>& buffer,
                                         juce::MidiBuffer& midiMessages)
{
    // Плагин сам ничего не озвучивает — выдаём тишину
    buffer.clear();

    // Всё, что пришло из DAW (игра на клавиатуре), отдаём приложениям
    for (const auto meta : midiMessages)
    {
        const auto message = meta.getMessage();
        const auto* raw = message.getRawData();
        const auto size = message.getRawDataSize();

        // системные сообщения (0xf0 и выше) приложениям не нужны
        if (size >= 1 && size <= 3 && raw[0] < 0xf0)
            incoming.push (raw[0],
                           size > 1 ? raw[1] : (juce::uint8) 0,
                           size > 2 ? raw[2] : (juce::uint8) 0);
    }

    // Входящие ноты дальше по цепочке не идут: что именно отправить в DAW,
    // решают сами приложения — ровно как в браузерной версии
    midiMessages.clear();

    std::array<juce::uint8, 3> message {};

    while (outgoing.pop (message))
    {
        const auto status = message[0] & 0xf0;

        // Program Change и Channel Pressure — двухбайтовые, остальные три байта
        if (status == 0xc0 || status == 0xd0)
            midiMessages.addEvent (juce::MidiMessage (message[0], message[1]), 0);
        else
            midiMessages.addEvent (juce::MidiMessage (message[0], message[1], message[2]), 0);
    }
}

//==============================================================================
juce::String MusicTheoryProcessor::getStorageJson() const
{
    const juce::ScopedLock lock (storageLock);
    return storageJson;
}

void MusicTheoryProcessor::setStorageJson (const juce::String& json)
{
    const juce::ScopedLock lock (storageLock);
    storageJson = json.isEmpty() ? "{}" : json;
}

//==============================================================================
juce::AudioProcessorEditor* MusicTheoryProcessor::createEditor()
{
    return new MusicTheoryEditor (*this);
}

void MusicTheoryProcessor::getStateInformation (juce::MemoryBlock& destData)
{
    juce::ValueTree state ("MusicTheoryVSTState");

    state.setProperty ("storage", getStorageJson(), nullptr);

    if (auto* editor = getActiveEditor())
    {
        state.setProperty ("editorWidth",  editor->getWidth(),  nullptr);
        state.setProperty ("editorHeight", editor->getHeight(), nullptr);
    }
    else
    {
        state.setProperty ("editorWidth",  lastEditorWidth,  nullptr);
        state.setProperty ("editorHeight", lastEditorHeight, nullptr);
    }

    if (auto xml = state.createXml())
        copyXmlToBinary (*xml, destData);
}

void MusicTheoryProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    if (auto xml = getXmlFromBinary (data, sizeInBytes))
    {
        const auto state = juce::ValueTree::fromXml (*xml);

        if (! state.isValid())
            return;

        setStorageJson (state.getProperty ("storage", "{}").toString());

        lastEditorWidth  = state.getProperty ("editorWidth",  lastEditorWidth);
        lastEditorHeight = state.getProperty ("editorHeight", lastEditorHeight);

        // окно плагина могло быть открыто раньше, чем DAW прислала настройки
        // проекта — редактор увидит новое число и перечитает их
        storageRevision.fetch_add (1);
    }
}

//==============================================================================
juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new MusicTheoryProcessor();
}
