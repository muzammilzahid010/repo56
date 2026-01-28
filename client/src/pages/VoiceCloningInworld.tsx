import { useState, useRef, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Play, Pause, Download, Volume2, Sparkles, Zap, RotateCcw } from "lucide-react";
import UserPanelLayout from "@/layouts/UserPanelLayout";

const INWORLD_VOICES = [
  { id: "Timothy", name: "Timothy", gender: "Male", style: "Warm & Friendly" },
  { id: "Luna", name: "Luna", gender: "Female", style: "Calm & Soothing" },
  { id: "Marcus", name: "Marcus", gender: "Male", style: "Professional" },
  { id: "Elena", name: "Elena", gender: "Female", style: "Energetic" },
  { id: "James", name: "James", gender: "Male", style: "Authoritative" },
  { id: "Sophia", name: "Sophia", gender: "Female", style: "Warm & Expressive" },
  { id: "Oliver", name: "Oliver", gender: "Male", style: "Youthful" },
  { id: "Emma", name: "Emma", gender: "Female", style: "Friendly" },
];

const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "es", name: "Spanish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "it", name: "Italian" },
  { code: "pt", name: "Portuguese" },
  { code: "zh", name: "Chinese" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "hi", name: "Hindi" },
  { code: "ar", name: "Arabic" },
  { code: "ru", name: "Russian" },
];

const MODELS = [
  { id: "inworld/tts-1.5-mini", name: "TTS 1.5 Mini", description: "Fast & efficient" },
];

interface GenerateResponse {
  success: boolean;
  audioUrl?: string;
  audioBase64?: string;
  audioFormat?: string;
  error?: string;
}

export default function VoiceCloningInworld() {
  const { toast } = useToast();
  const audioRef = useRef<HTMLAudioElement>(null);
  
  const [text, setText] = useState("");
  const [voice, setVoice] = useState("Timothy");
  const [model, setModel] = useState("inworld/tts-1.5-mini");
  const [language, setLanguage] = useState("en");
  const [speed, setSpeed] = useState([1.0]);
  const [temperature, setTemperature] = useState([0.7]);
  
  const [generatedAudio, setGeneratedAudio] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const { data: session } = useQuery<{
    authenticated: boolean;
    user?: { username: string; isAdmin: boolean };
  }>({
    queryKey: ['/api/session'],
  });

  const generateMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/inworld-tts/generate", {
        text,
        voice,
        model,
        language,
        speed: speed[0],
        temperature: temperature[0],
      });
      return response.json() as Promise<GenerateResponse>;
    },
    onSuccess: (data) => {
      if (data.success && (data.audioUrl || data.audioBase64)) {
        // Handle base64 audio from direct Inworld API (MP3 format)
        if (data.audioBase64) {
          try {
            // Convert base64 to binary and create Blob URL for better browser compatibility
            const binaryString = atob(data.audioBase64);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            const blob = new Blob([bytes], { type: 'audio/mpeg' });
            const blobUrl = URL.createObjectURL(blob);
            console.log("[Inworld TTS] Blob URL created:", blobUrl);
            setGeneratedAudio(blobUrl);
          } catch (e) {
            console.error("[Inworld TTS] Failed to decode audio:", e);
            toast({
              title: "Audio Error", 
              description: "Failed to decode audio data",
              variant: "destructive",
            });
          }
        } else if (data.audioUrl) {
          setGeneratedAudio(data.audioUrl);
        }
        toast({
          title: "Audio Generated",
          description: "Your audio is ready to play!",
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

  const handlePlay = () => {
    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
      } else {
        audioRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const handleDownload = () => {
    if (generatedAudio) {
      const a = document.createElement('a');
      a.href = generatedAudio;
      a.download = `inworld-tts-${Date.now()}.mp3`;
      a.click();
    }
  };

  const handleAudioEnded = () => {
    setIsPlaying(false);
    setCurrentTime(0);
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    if (audioRef.current) {
      setDuration(audioRef.current.duration);
    }
  };

  const handleSeek = (value: number[]) => {
    if (audioRef.current) {
      audioRef.current.currentTime = value[0];
      setCurrentTime(value[0]);
    }
  };

  const handleRestart = () => {
    if (audioRef.current) {
      audioRef.current.currentTime = 0;
      setCurrentTime(0);
      audioRef.current.play();
      setIsPlaying(true);
    }
  };

  const formatTime = (time: number) => {
    const mins = Math.floor(time / 60);
    const secs = Math.floor(time % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const characterCount = text.length;
  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;

  if (!session?.authenticated) {
    return (
      <UserPanelLayout>
        <div className="flex items-center justify-center h-full">
          <p className="text-muted-foreground">Please login to access this tool.</p>
        </div>
      </UserPanelLayout>
    );
  }

  return (
    <UserPanelLayout>
      <div className="container mx-auto p-6 max-w-6xl">
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-gradient-to-br from-purple-500 to-pink-500 rounded-lg">
              <Sparkles className="w-6 h-6 text-white" />
            </div>
            <h1 className="text-3xl font-bold">Voice Cloning V2</h1>
          </div>
          <p className="text-muted-foreground">
            Ultra-realistic text-to-speech powered by Inworld AI. Generate natural, expressive voices with low latency.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Volume2 className="w-5 h-5" />
                  Text Input
                </CardTitle>
                <CardDescription>
                  Enter the text you want to convert to speech
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Textarea
                  placeholder="Enter your text here... You can use emotional markers like [happy], [sad], [whisper] for expressive speech."
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  className="min-h-[200px] resize-none"
                  data-testid="input-text"
                />
                <div className="flex justify-between text-sm text-muted-foreground">
                  <span>{characterCount} characters</span>
                  <span>{wordCount} words</span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Voice Settings</CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Voice</Label>
                    <Select value={voice} onValueChange={setVoice}>
                      <SelectTrigger data-testid="select-voice">
                        <SelectValue placeholder="Select a voice" />
                      </SelectTrigger>
                      <SelectContent>
                        {INWORLD_VOICES.map((v) => (
                          <SelectItem key={v.id} value={v.id}>
                            <div className="flex items-center gap-2">
                              <span>{v.name}</span>
                              <span className="text-xs text-muted-foreground">
                                ({v.gender} - {v.style})
                              </span>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Language</Label>
                    <Select value={language} onValueChange={setLanguage}>
                      <SelectTrigger data-testid="select-language">
                        <SelectValue placeholder="Select language" />
                      </SelectTrigger>
                      <SelectContent>
                        {LANGUAGES.map((lang) => (
                          <SelectItem key={lang.code} value={lang.code}>
                            {lang.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Model</Label>
                  <Select value={model} onValueChange={setModel}>
                    <SelectTrigger data-testid="select-model">
                      <SelectValue placeholder="Select model" />
                    </SelectTrigger>
                    <SelectContent>
                      {MODELS.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          <div className="flex flex-col">
                            <span>{m.name}</span>
                            <span className="text-xs text-muted-foreground">{m.description}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-4">
                  <div className="space-y-2">
                    <div className="flex justify-between">
                      <Label>Speed</Label>
                      <span className="text-sm text-muted-foreground">{speed[0]}x</span>
                    </div>
                    <Slider
                      value={speed}
                      onValueChange={setSpeed}
                      min={0.5}
                      max={1.5}
                      step={0.1}
                      data-testid="slider-speed"
                    />
                  </div>

                  <div className="space-y-2">
                    <div className="flex justify-between">
                      <Label>Temperature (Expressiveness)</Label>
                      <span className="text-sm text-muted-foreground">{temperature[0]}</span>
                    </div>
                    <Slider
                      value={temperature}
                      onValueChange={setTemperature}
                      min={0.1}
                      max={1.0}
                      step={0.1}
                      data-testid="slider-temperature"
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Zap className="w-5 h-5" />
                  Generate
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <Button
                  className="w-full"
                  size="lg"
                  onClick={() => generateMutation.mutate()}
                  disabled={!text.trim() || generateMutation.isPending}
                  data-testid="button-generate"
                >
                  {generateMutation.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Generating...
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4 mr-2" />
                      Generate Audio
                    </>
                  )}
                </Button>

                {generatedAudio && (
                  <div className="space-y-4 pt-4 border-t">
                    <audio
                      ref={audioRef}
                      src={generatedAudio}
                      onEnded={handleAudioEnded}
                      onTimeUpdate={handleTimeUpdate}
                      onLoadedMetadata={handleLoadedMetadata}
                      onError={(e) => {
                        console.error("Audio error:", e);
                        toast({
                          title: "Audio Error",
                          description: "Failed to load audio. Try generating again.",
                          variant: "destructive",
                        });
                      }}
                      className="hidden"
                    />
                    
                    <div className="bg-gradient-to-r from-purple-500/10 via-pink-500/10 to-purple-500/10 rounded-xl p-4 border border-purple-500/20">
                      <div className="flex items-center gap-4">
                        <Button
                          size="icon"
                          className="h-12 w-12 rounded-full bg-purple-600 hover:bg-purple-700 text-white shadow-lg"
                          onClick={handlePlay}
                          data-testid="button-play"
                        >
                          {isPlaying ? (
                            <Pause className="w-5 h-5" />
                          ) : (
                            <Play className="w-5 h-5 ml-0.5" />
                          )}
                        </Button>
                        
                        <div className="flex-1 space-y-2">
                          <Slider
                            value={[currentTime]}
                            onValueChange={handleSeek}
                            max={duration || 100}
                            step={0.1}
                            className="cursor-pointer"
                            data-testid="slider-progress"
                          />
                          <div className="flex justify-between text-xs text-muted-foreground">
                            <span>{formatTime(currentTime)}</span>
                            <span>{formatTime(duration)}</span>
                          </div>
                        </div>
                        
                        <div className="flex gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={handleRestart}
                            className="h-9 w-9 text-muted-foreground hover:text-foreground"
                            data-testid="button-restart"
                          >
                            <RotateCcw className="w-4 h-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={handleDownload}
                            className="h-9 w-9 text-muted-foreground hover:text-foreground"
                            data-testid="button-download"
                          >
                            <Download className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                      
                      <div className="mt-3 flex items-center justify-center gap-2 text-xs text-muted-foreground">
                        <Volume2 className="w-3 h-3" />
                        <span>Generated with Inworld TTS</span>
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Tips</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-muted-foreground">
                <p><strong>Emotional Markers:</strong> Use [happy], [sad], [whisper], [cough], [sigh] in your text for expressive speech.</p>
                <p><strong>Speed:</strong> 0.5x is slower, 1.5x is faster. 1.0x is normal speed.</p>
                <p><strong>Temperature:</strong> Higher values = more expressive/random. Lower = more consistent.</p>
                <p><strong>Model Choice:</strong> Use TTS 1.5 Max for best quality, Mini for speed.</p>
              </CardContent>
            </Card>

            <Card className="bg-gradient-to-br from-purple-500/10 to-pink-500/10 border-purple-500/20">
              <CardContent className="pt-6">
                <div className="text-center space-y-2">
                  <Sparkles className="w-8 h-8 mx-auto text-purple-500" />
                  <h3 className="font-semibold">Inworld TTS</h3>
                  <p className="text-sm text-muted-foreground">
                    15 languages supported with ultra-low latency and natural expressiveness.
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </UserPanelLayout>
  );
}
