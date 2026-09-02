#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <array>
#include <atomic>
#include <vector>

//==============================================================================
//  Очередь коротких MIDI-сообщений между потоком звука и потоком интерфейса.
//  Пишет всегда один поток, читает другой, поэтому блокировки не нужны:
//  дёргать мьютекс в потоке звука нельзя — это даёт щелчки.
//==============================================================================
class MidiQueue
{
public:
    MidiQueue() { storage.resize ((size_t) capacity); }

    void push (juce::uint8 b0, juce::uint8 b1, juce::uint8 b2)
    {
        const auto scope = fifo.write (1);

        if (scope.blockSize1 > 0)
            storage[(size_t) scope.startIndex1] = { b0, b1, b2 };
        else if (scope.blockSize2 > 0)
            storage[(size_t) scope.startIndex2] = { b0, b1, b2 };
        // если очередь переполнена — сообщение просто теряется,
        // это лучше, чем ждать в потоке звука
    }

    bool pop (std::array<juce::uint8, 3>& result)
    {
        const auto scope = fifo.read (1);

        if (scope.blockSize1 > 0) { result = storage[(size_t) scope.startIndex1]; return true; }
        if (scope.blockSize2 > 0) { result = storage[(size_t) scope.startIndex2]; return true; }

        return false;
    }

private:
    static constexpr int capacity = 2048;

    juce::AbstractFifo fifo { capacity };
    std::vector<std::array<juce::uint8, 3>> storage;
};

//==============================================================================
class MusicTheoryProcessor : public juce::AudioProcessor
{
public:
    MusicTheoryProcessor();
    ~MusicTheoryProcessor() override = default;

    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override {}
    bool isBusesLayoutSupported (const BusesLayout& layouts) const override;
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }

    const juce::String getName() const override { return JucePlugin_Name; }
    bool acceptsMidi() const override  { return true; }
    bool producesMidi() const override { return true; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return {}; }
    void changeProgramName (int, const juce::String&) override {}

    void getStateInformation (juce::MemoryBlock& destData) override;
    void setStateInformation (const void* data, int sizeInBytes) override;

    //==========================================================================
    //  Настройки приложений. В браузере они лежали в localStorage, здесь тем
    //  же ключам соответствует один JSON-объект, который сохраняется вместе
    //  с проектом DAW (см. plugin-bridge.js).
    juce::String getStorageJson() const;
    void setStorageJson (const juce::String& json);

    //  Растёт, когда настройки пришли из проекта. Редактор смотрит на это
    //  число и, если оно изменилось, отдаёт новые настройки в окно.
    int getStorageRevision() const noexcept { return storageRevision.load(); }

    //==========================================================================
    //  Ноты из окна плагина -> в DAW
    void sendMidiToHost (int b0, int b1, int b2)
    {
        outgoing.push ((juce::uint8) (b0 & 0xff),
                       (juce::uint8) (b1 & 0xff),
                       (juce::uint8) (b2 & 0xff));
    }

    //  Ноты из DAW -> в окно плагина
    bool getNextMidiFromHost (std::array<juce::uint8, 3>& message)
    {
        return incoming.pop (message);
    }

    //  Размер окна плагина — сохраняется вместе с проектом
    int lastEditorWidth  = 1280;
    int lastEditorHeight = 800;

private:
    mutable juce::CriticalSection storageLock;
    juce::String storageJson { "{}" };
    std::atomic<int> storageRevision { 0 };

    MidiQueue incoming, outgoing;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MusicTheoryProcessor)
};
