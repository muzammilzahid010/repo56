import { useState, useRef, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Volume2, Download, Loader2, Play, Pause, Zap, Search, Globe, Square, BarChart3, ChevronLeft, ChevronRight } from "lucide-react";
import UserPanelLayout from "@/layouts/UserPanelLayout";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";

interface TTSV2Response {
  success: boolean;
  audioId?: string;
  mimeType?: string;
  charactersUsed?: number;
  error?: string;
}

interface VoiceUsageResponse {
  used: number;
  limit: number;
  remaining: number;
  resetDate: string | null;
  resetDays: number;
  planType: string;
  isAdmin: boolean;
}

interface CartesiaVoice {
  id: string;
  name: string;
  description: string;
  language: string;
  is_public: boolean;
}

export default function TextToSpeechV2() {
  const { toast } = useToast();
  const audioRef = useRef<HTMLAudioElement>(null);
  const previewAudioRef = useRef<HTMLAudioElement>(null);
  const [text, setText] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [language, setLanguage] = useState("en");
  const [speed, setSpeed] = useState("normal");
  const [emotion, setEmotion] = useState("none");
  const [searchQuery, setSearchQuery] = useState("");
  const [generatedAudio, setGeneratedAudio] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [previewingVoiceId, setPreviewingVoiceId] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState<string | null>(null);
  const [voicePage, setVoicePage] = useState(0);
  const voicesPerPage = 50;

  const { data: session } = useQuery<{
    authenticated: boolean;
    user?: { username: string; isAdmin: boolean };
  }>({
    queryKey: ['/api/session'],
  });


  const { data: voicesData, isLoading: loadingVoices } = useQuery<{ voices: CartesiaVoice[] }>({
    queryKey: ["/api/tts-v2/voices"],
    enabled: session?.authenticated === true,
  });

  const { data: usageData } = useQuery<VoiceUsageResponse>({
    queryKey: ["/api/user/voice-usage"],
    enabled: session?.authenticated === true,
  });

  const filteredVoices = voicesData?.voices?.filter(v => {
    const matchesSearch = !searchQuery || 
      v.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      v.description?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesLanguage = !language || language === "all" || v.language?.startsWith(language);
    return matchesSearch && matchesLanguage;
  }) || [];

  // Pagination
  const totalPages = Math.ceil(filteredVoices.length / voicesPerPage);
  const paginatedVoices = filteredVoices.slice(voicePage * voicesPerPage, (voicePage + 1) * voicesPerPage);

  // Reset page when filters change
  useEffect(() => {
    setVoicePage(0);
  }, [searchQuery, language]);

  const ttsMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/tts-v2/synthesize", {
        text,
        voiceId,
        language,
        speed: speed !== "normal" ? speed : undefined,
        emotion: emotion !== "none" ? emotion : undefined,
      });
      return response.json() as Promise<TTSV2Response>;
    },
    onSuccess: (data) => {
      if (data.success && data.audioId) {
        const audioUrl = `/api/tts-v2/audio/${data.audioId}`;
        setGeneratedAudio(audioUrl);
        // Invalidate and refetch usage immediately
        queryClient.invalidateQueries({ queryKey: ["/api/user/voice-usage"] });
        toast({
          title: "Audio Generated",
          description: `Audio generated (${(data.charactersUsed || 0).toLocaleString()} characters)`,
        });
      } else {
        toast({
          title: "Generation Failed",
          description: data.error || "Failed to generate audio",
          variant: "destructive",
        });
      }
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to generate audio",
        variant: "destructive",
      });
    },
  });

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (generatedAudio) {
      audio.load();
    }

    const handleTimeUpdate = () => setCurrentTime(audio.currentTime);
    const handleLoadedMetadata = () => setDuration(audio.duration);
    const handleEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
    };

    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("loadedmetadata", handleLoadedMetadata);
    audio.addEventListener("ended", handleEnded);

    return () => {
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
      audio.removeEventListener("ended", handleEnded);
    };
  }, [generatedAudio]);

  const formatTime = (time: number) => {
    if (!isFinite(time) || isNaN(time)) return "0:00";
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!audioRef.current || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const newTime = (clickX / rect.width) * duration;
    audioRef.current.currentTime = newTime;
    setCurrentTime(newTime);
  };

  const togglePlayPause = () => {
    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
      } else {
        audioRef.current.play().catch(err => {
          console.error("Error playing audio:", err);
          toast({
            title: "Playback Error",
            description: "Could not play audio. Try downloading instead.",
            variant: "destructive",
          });
        });
      }
      setIsPlaying(!isPlaying);
    }
  };

  const downloadAudio = () => {
    if (generatedAudio) {
      const link = document.createElement("a");
      link.href = generatedAudio;
      link.download = "voice-audio.mp3";
      link.click();
    }
  };

  // Language-specific preview texts
  const getPreviewText = (langCode: string, voiceName: string): string => {
    const lang = langCode?.split("-")[0] || "en";
    const previewTexts: Record<string, string> = {
      en: `Hello! This is ${voiceName}. I can speak with natural expression and emotion.`,
      es: `¡Hola! Soy ${voiceName}. Puedo hablar con expresión natural y emoción.`,
      fr: `Bonjour! Je suis ${voiceName}. Je peux parler avec expression naturelle et émotion.`,
      de: `Hallo! Ich bin ${voiceName}. Ich kann mit natürlichem Ausdruck und Emotion sprechen.`,
      it: `Ciao! Sono ${voiceName}. Posso parlare con espressione naturale ed emozione.`,
      pt: `Olá! Eu sou ${voiceName}. Posso falar com expressão natural e emoção.`,
      ja: `こんにちは！私は${voiceName}です。自然な表現と感情で話すことができます。`,
      ko: `안녕하세요! 저는 ${voiceName}입니다. 자연스러운 표현과 감정으로 말할 수 있습니다.`,
      zh: `你好！我是${voiceName}。我可以用自然的表达和情感说话。`,
      ar: `مرحباً! أنا ${voiceName}. يمكنني التحدث بتعبير طبيعي وعاطفة.`,
      hi: `नमस्ते! मैं ${voiceName} हूं। मैं स्वाभाविक अभिव्यक्ति और भावना के साथ बोल सकता हूं।`,
      ru: `Привет! Я ${voiceName}. Я могу говорить с естественным выражением и эмоцией.`,
      tr: `Merhaba! Ben ${voiceName}. Doğal ifade ve duyguyla konuşabilirim.`,
      nl: `Hallo! Ik ben ${voiceName}. Ik kan spreken met natuurlijke expressie en emotie.`,
      pl: `Cześć! Jestem ${voiceName}. Mogę mówić z naturalną ekspresją i emocjami.`,
      sv: `Hej! Jag är ${voiceName}. Jag kan tala med naturligt uttryck och känsla.`,
    };
    return previewTexts[lang] || previewTexts.en;
  };

  const playVoicePreview = async (voice: CartesiaVoice) => {
    // If already previewing this voice, stop it
    if (previewingVoiceId === voice.id) {
      if (previewAudioRef.current) {
        previewAudioRef.current.pause();
        previewAudioRef.current.currentTime = 0;
      }
      setPreviewingVoiceId(null);
      return;
    }

    // Stop any currently playing preview
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current.currentTime = 0;
    }

    setLoadingPreview(voice.id);

    try {
      const previewText = getPreviewText(voice.language, voice.name);
      const response = await apiRequest("POST", "/api/tts-v2/synthesize", {
        text: previewText,
        voiceId: voice.id,
        language: voice.language || "en",
      });
      const data = await response.json() as TTSV2Response;
      
      if (data.success && data.audioId) {
        const audioUrl = `/api/tts-v2/audio/${data.audioId}`;
        if (previewAudioRef.current) {
          previewAudioRef.current.src = audioUrl;
          previewAudioRef.current.load();
          await previewAudioRef.current.play();
          setPreviewingVoiceId(voice.id);
        }
        // Refetch usage after preview (preview also consumes characters)
        queryClient.invalidateQueries({ queryKey: ["/api/user/voice-usage"] });
      } else {
        toast({
          title: "Preview Failed",
          description: data.error || "Could not generate preview",
          variant: "destructive",
        });
      }
    } catch (error: any) {
      toast({
        title: "Preview Error",
        description: error.message || "Failed to play preview",
        variant: "destructive",
      });
    } finally {
      setLoadingPreview(null);
    }
  };

  // Handle preview audio ended
  useEffect(() => {
    const previewAudio = previewAudioRef.current;
    if (!previewAudio) return;

    const handleEnded = () => setPreviewingVoiceId(null);
    previewAudio.addEventListener("ended", handleEnded);
    return () => previewAudio.removeEventListener("ended", handleEnded);
  }, []);

  const languages = [
    { code: "all", name: "All Languages" },
    { code: "en", name: "English" },
    { code: "es", name: "Spanish" },
    { code: "fr", name: "French" },
    { code: "de", name: "German" },
    { code: "it", name: "Italian" },
    { code: "pt", name: "Portuguese" },
    { code: "ja", name: "Japanese" },
    { code: "ko", name: "Korean" },
    { code: "zh", name: "Chinese" },
    { code: "ar", name: "Arabic" },
    { code: "hi", name: "Hindi" },
    { code: "ru", name: "Russian" },
    { code: "tr", name: "Turkish" },
    { code: "nl", name: "Dutch" },
    { code: "pl", name: "Polish" },
    { code: "sv", name: "Swedish" },
  ];

  const emotions = [
    { value: "none", label: "None (Natural)" },
    { value: "positivity", label: "Positive" },
    { value: "negativity", label: "Negative" },
    { value: "anger", label: "Angry" },
    { value: "sadness", label: "Sad" },
    { value: "curiosity", label: "Curious" },
    { value: "surprise", label: "Surprised" },
  ];

  return (
    <UserPanelLayout>
      <div className="p-6 max-w-5xl mx-auto space-y-6">
        <div className="flex items-center justify-between gap-3 mb-6 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-gradient-to-br from-purple-500 to-pink-500 rounded-lg">
              <Zap className="w-6 h-6 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-bold text-foreground">Text to Voice V2</h1>
              </div>
              <p className="text-muted-foreground">Ultra-low latency, emotionally expressive AI voices</p>
            </div>
          </div>
        </div>

        {usageData && (
          <Card className="border-purple-200 dark:border-purple-800 bg-gradient-to-r from-purple-50 to-pink-50 dark:from-purple-950/20 dark:to-pink-950/20">
            <CardContent className="py-4">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-3">
                  <BarChart3 className="w-5 h-5 text-purple-500" />
                  <div>
                    <p className="text-sm font-medium">Character Usage</p>
                    <p className="text-xs text-muted-foreground">
                      {usageData.limit === -1 ? (
                        "Unlimited characters"
                      ) : (
                        <>Resets every {usageData.resetDays} days</>
                      )}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4 flex-1 min-w-[200px] max-w-md">
                  <div className="flex-1">
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-muted-foreground">
                        {usageData.used.toLocaleString()} used
                      </span>
                      <span className="font-medium text-purple-600 dark:text-purple-400">
                        {usageData.limit === -1 ? "Unlimited" : `${usageData.remaining.toLocaleString()} remaining`}
                      </span>
                    </div>
                    {usageData.limit !== -1 && (
                      <Progress 
                        value={(usageData.used / usageData.limit) * 100} 
                        className="h-2"
                      />
                    )}
                  </div>
                  <Badge variant="outline" className="border-purple-300 text-purple-600 dark:text-purple-400 shrink-0">
                    {usageData.limit === -1 ? "Admin" : `${(usageData.limit / 1000).toLocaleString()}K`}
                  </Badge>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Globe className="w-5 h-5" />
                Select Voice
              </CardTitle>
              <CardDescription>Choose from {voicesData?.voices?.length || 0} available voices</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-3">
                <div className="flex-1 relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    placeholder="Search voices..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-9"
                    data-testid="input-search-voice"
                  />
                </div>
                <Select value={language} onValueChange={setLanguage}>
                  <SelectTrigger className="w-40" data-testid="select-language-filter">
                    <SelectValue placeholder="Language" />
                  </SelectTrigger>
                  <SelectContent>
                    {languages.map((lang) => (
                      <SelectItem key={lang.code} value={lang.code}>
                        {lang.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Voice ({filteredVoices.length} available)</Label>
                <audio ref={previewAudioRef} className="hidden" />
                {loadingVoices ? (
                  <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Loading voices...
                  </div>
                ) : filteredVoices.length > 0 ? (
                  <ScrollArea className="h-[300px] rounded-md border p-2">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      {paginatedVoices.map((voice) => (
                        <div
                          key={voice.id}
                          className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                            voiceId === voice.id
                              ? "border-purple-500 bg-purple-50 dark:bg-purple-900/20"
                              : "border-border hover:border-purple-300 hover:bg-muted/50"
                          }`}
                          onClick={() => setVoiceId(voice.id)}
                          data-testid={`voice-card-${voice.id}`}
                        >
                          <Button
                            variant="outline"
                            size="icon"
                            className={`shrink-0 h-9 w-9 ${
                              previewingVoiceId === voice.id 
                                ? "border-pink-500 text-pink-500" 
                                : "border-purple-300 text-purple-500"
                            }`}
                            onClick={(e) => {
                              e.stopPropagation();
                              playVoicePreview(voice);
                            }}
                            disabled={loadingPreview === voice.id}
                            data-testid={`preview-voice-${voice.id}`}
                          >
                            {loadingPreview === voice.id ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : previewingVoiceId === voice.id ? (
                              <Square className="w-3 h-3 fill-current" />
                            ) : (
                              <Play className="w-4 h-4" />
                            )}
                          </Button>
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-sm truncate">{voice.name}</p>
                            {voice.description && (
                              <p className="text-xs text-muted-foreground truncate">
                                {voice.description}
                              </p>
                            )}
                            <p className="text-xs text-purple-500 dark:text-purple-400">
                              {voice.language || "en"}
                            </p>
                          </div>
                          {voiceId === voice.id && (
                            <div className="w-2 h-2 rounded-full bg-purple-500 shrink-0" />
                          )}
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                ) : (
                  <div className="py-8 text-center text-muted-foreground">
                    No voices found. Try adjusting your search.
                  </div>
                )}
                {totalPages > 1 && (
                  <div className="flex items-center justify-between pt-2">
                    <p className="text-xs text-muted-foreground">
                      Showing {voicePage * voicesPerPage + 1}-{Math.min((voicePage + 1) * voicesPerPage, filteredVoices.length)} of {filteredVoices.length} voices
                    </p>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setVoicePage(p => Math.max(0, p - 1))}
                        disabled={voicePage === 0}
                        data-testid="button-prev-voices"
                      >
                        <ChevronLeft className="w-4 h-4 mr-1" />
                        Previous
                      </Button>
                      <span className="text-sm text-muted-foreground px-2">
                        {voicePage + 1} / {totalPages}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setVoicePage(p => Math.min(totalPages - 1, p + 1))}
                        disabled={voicePage >= totalPages - 1}
                        data-testid="button-next-voices"
                      >
                        Next
                        <ChevronRight className="w-4 h-4 ml-1" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Voice Controls</CardTitle>
              <CardDescription>Adjust speed and emotion</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Speed</Label>
                <Select value={speed} onValueChange={setSpeed}>
                  <SelectTrigger data-testid="select-speed">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="slow">Slow</SelectItem>
                    <SelectItem value="normal">Normal</SelectItem>
                    <SelectItem value="fast">Fast</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Emotion</Label>
                <Select value={emotion} onValueChange={setEmotion}>
                  <SelectTrigger data-testid="select-emotion">
                    <SelectValue placeholder="Select emotion" />
                  </SelectTrigger>
                  <SelectContent>
                    {emotions.map((em) => (
                      <SelectItem key={em.value} value={em.value}>
                        {em.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Experimental: Add emotional tone to speech
                </p>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Text to Speak</CardTitle>
            <CardDescription>Enter text to convert to speech (max 10,000 characters)</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Textarea
              placeholder="Enter your text here..."
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, 10000))}
              rows={6}
              data-testid="textarea-text-v2"
            />
            <div className="flex justify-between items-center">
              <span className={`text-sm ${text.length > 9000 ? 'text-orange-500' : 'text-muted-foreground'}`}>
                {text.length.toLocaleString()} / 10,000 characters
              </span>
              <Button
                onClick={() => ttsMutation.mutate()}
                disabled={!text.trim() || !voiceId || ttsMutation.isPending}
                className="bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600"
                data-testid="button-generate-v2"
              >
                {ttsMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <Volume2 className="w-4 h-4 mr-2" />
                    Generate Voice
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        {generatedAudio && (
          <Card className="border-purple-200 dark:border-purple-800">
            <CardHeader>
              <CardTitle>Generated Audio</CardTitle>
              <CardDescription>Your audio is ready</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <audio ref={audioRef} src={generatedAudio} className="hidden" />
              <div className="flex items-center gap-4">
                <Button
                  variant="outline"
                  size="icon"
                  onClick={togglePlayPause}
                  className="border-purple-300 dark:border-purple-700"
                  data-testid="button-play-pause-v2"
                >
                  {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                </Button>
                <div className="flex-1 space-y-1">
                  <div 
                    className="h-2 bg-muted rounded-full cursor-pointer relative overflow-hidden"
                    onClick={handleProgressClick}
                    data-testid="progress-bar-v2"
                  >
                    <div 
                      className="h-full bg-gradient-to-r from-purple-500 to-pink-500 rounded-full transition-all duration-100" 
                      style={{ width: duration > 0 ? `${(currentTime / duration) * 100}%` : "0%" }}
                    />
                  </div>
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>{formatTime(currentTime)}</span>
                    <span>{formatTime(duration)}</span>
                  </div>
                </div>
                <Button 
                  onClick={downloadAudio} 
                  className="bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600"
                  data-testid="button-download-v2"
                >
                  <Download className="w-4 h-4 mr-2" />
                  Download
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </UserPanelLayout>
  );
}
