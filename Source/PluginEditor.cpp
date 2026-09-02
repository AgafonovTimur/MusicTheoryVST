#include "PluginEditor.h"
#include "BinaryData.h"

#include <optional>
#include <vector>

//==============================================================================
//  Файлы приложений вшиты в плагин. Браузер внутри окна запрашивает их
//  обычными адресами (index.html, circle_of_fifths.html и т.д.), а мы
//  отдаём содержимое прямо из памяти — интернет и папка на диске не нужны.
//==============================================================================
namespace
{
    juce::String mimeTypeFor (const juce::String& fileName)
    {
        if (fileName.endsWithIgnoreCase (".html") || fileName.endsWithIgnoreCase (".htm"))
            return "text/html; charset=utf-8";
        if (fileName.endsWithIgnoreCase (".js"))
            return "application/javascript; charset=utf-8";
        if (fileName.endsWithIgnoreCase (".css"))
            return "text/css; charset=utf-8";
        if (fileName.endsWithIgnoreCase (".json"))
            return "application/json; charset=utf-8";
        if (fileName.endsWithIgnoreCase (".svg"))
            return "image/svg+xml";
        if (fileName.endsWithIgnoreCase (".png"))
            return "image/png";
        if (fileName.endsWithIgnoreCase (".ttf"))
            return "font/ttf";

        return "application/octet-stream";
    }

    // Ищем вшитый файл по его исходному имени, а не по имени переменной:
    // так дефис в note-trainer.html и точки в именах ничего не ломают.
    const char* findBinaryData (const juce::String& fileName, int& dataSize)
    {
        for (int i = 0; i < BinaryData::namedResourceListSize; ++i)
        {
            const auto* resourceName = BinaryData::namedResourceList[i];

            if (fileName.equalsIgnoreCase (BinaryData::getNamedResourceOriginalFilename (resourceName)))
                return BinaryData::getNamedResource (resourceName, dataSize);
        }

        dataSize = 0;
        return nullptr;
    }

    juce::String loadTextResource (const juce::String& fileName)
    {
        int dataSize = 0;

        if (const auto* data = findBinaryData (fileName, dataSize))
            return juce::String::fromUTF8 (data, dataSize);

        return {};
    }

    std::optional<juce::WebBrowserComponent::Resource> provideResource (const juce::String& url)
    {
        auto path = url.upToFirstOccurrenceOf ("?", false, false);

        if (path.startsWithChar ('/'))
            path = path.substring (1);

        if (path.isEmpty())
            path = "index.html";

        int dataSize = 0;

        if (const auto* data = findBinaryData (path, dataSize))
        {
            const auto* begin = reinterpret_cast<const std::byte*> (data);

            juce::WebBrowserComponent::Resource resource;
            resource.data = std::vector<std::byte> (begin, begin + (size_t) dataSize);
            resource.mimeType = mimeTypeFor (path);

            return resource;
        }

        return std::nullopt;
    }

    // WebView2 отказывается работать, если ему негде хранить свои данные:
    // папка по умолчанию находится рядом с программой (у DAW это обычно
    // Program Files, куда писать нельзя), поэтому задаём свою.
    juce::File webViewDataFolder()
    {
        auto folder = juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory)
                          .getChildFile ("Music Theory VST")
                          .getChildFile ("WebView");

        folder.createDirectory();
        return folder;
    }
}

//==============================================================================
MusicTheoryEditor::MusicTheoryEditor (MusicTheoryProcessor& p)
    : juce::AudioProcessorEditor (&p),
      processor (p),
      webView (createOptions())
{
    addAndMakeVisible (webView);

    // Размер запоминаем ДО setResizeLimits: он подгоняет окно под свои
    // границы и успевает перезаписать сохранённое значение
    const auto savedWidth  = juce::jlimit (640, 4000, processor.lastEditorWidth);
    const auto savedHeight = juce::jlimit (400, 3000, processor.lastEditorHeight);

    // второй true — уголок для растягивания в правом нижнем углу
    setResizable (true, true);
    setResizeLimits (640, 400, 4000, 3000);
    setSize (savedWidth, savedHeight);

    webView.goToURL (juce::WebBrowserComponent::getResourceProviderRoot());

    lastStorageRevision = processor.getStorageRevision();

    ready = true;
    startTimerHz (60);
}

MusicTheoryEditor::~MusicTheoryEditor()
{
    if (ready)
    {
        processor.lastEditorWidth  = getWidth();
        processor.lastEditorHeight = getHeight();
    }
}

//==============================================================================
juce::WebBrowserComponent::Options MusicTheoryEditor::createOptions()
{
    using Options = juce::WebBrowserComponent::Options;

    return Options {}
        .withBackend (Options::Backend::webview2)
        .withWinWebView2Options (Options::WinWebView2 {}
                                     .withUserDataFolder (webViewDataFolder())
                                     .withStatusBarDisabled()
                                     .withBuiltInErrorPageDisabled()
                                     .withBackgroundColour (juce::Colours::black))
        .withNativeIntegrationEnabled()
        .withKeepPageLoadedWhenBrowserIsHidden()
        // мост выполняется в каждом фрейме раньше кода приложений
        .withUserScript (loadTextResource ("plugin-bridge.js"))
        // настройки проекта, которые приложения прочитают как localStorage
        .withInitialisationData ("mtStorage", processor.getStorageJson())
        .withEventListener ("mtMidiOut",
                            [this] (juce::var payload) { handleMidiFromWeb (payload); })
        .withEventListener ("mtSaveStorage",
                            [this] (juce::var payload) { handleStorageFromWeb (payload); })
        .withResourceProvider ([] (const juce::String& url) { return provideResource (url); });
}

//==============================================================================
void MusicTheoryEditor::handleMidiFromWeb (const juce::var& payload)
{
    const auto bytes = payload.getProperty ("b", juce::var());

    if (auto* array = bytes.getArray())
    {
        if (array->isEmpty())
            return;

        const auto byteAt = [array] (int index)
        {
            return index < array->size() ? (int) array->getReference (index) : 0;
        };

        processor.sendMidiToHost (byteAt (0), byteAt (1), byteAt (2));
    }
}

void MusicTheoryEditor::handleStorageFromWeb (const juce::var& payload)
{
    const auto json = payload.getProperty ("json", juce::var()).toString();

    if (json.isNotEmpty())
    {
        processor.setStorageJson (json);

        // DAW должна понять, что проект изменился и его надо сохранить
        processor.updateHostDisplay (juce::AudioProcessorListener::ChangeDetails {}
                                         .withNonParameterStateChanged (true));
    }
}

//==============================================================================
void MusicTheoryEditor::timerCallback()
{
    // ноты из DAW -> в приложения, пачкой за один раз
    juce::Array<juce::var> messages;
    std::array<juce::uint8, 3> message {};

    for (int i = 0; i < 256 && processor.getNextMidiFromHost (message); ++i)
    {
        juce::Array<juce::var> bytes;
        bytes.add ((int) message[0]);
        bytes.add ((int) message[1]);
        bytes.add ((int) message[2]);

        messages.add (juce::var (bytes));
    }

    if (! messages.isEmpty())
    {
        auto* object = new juce::DynamicObject();
        object->setProperty ("m", juce::var (messages));

        webView.emitEventIfBrowserIsVisible ("mtMidiIn", juce::var (object));
    }

    // проект загрузился уже после открытия окна — отдаём настройки в окно
    const auto revision = processor.getStorageRevision();

    if (revision != lastStorageRevision)
    {
        lastStorageRevision = revision;

        auto* object = new juce::DynamicObject();
        object->setProperty ("json", processor.getStorageJson());

        webView.emitEventIfBrowserIsVisible ("mtStorage", juce::var (object));
    }
}

//==============================================================================
void MusicTheoryEditor::paint (juce::Graphics& g)
{
    // видно по краям, когда пропорции окна не совпадают с пропорциями сцены
    g.fillAll (juce::Colours::black);
}

void MusicTheoryEditor::resized()
{
    webView.setBounds (getLocalBounds());
}
