import { useState, useRef, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Play, Pause, Download, Volume2, Sparkles, Zap, RotateCcw, Upload, Mic, UserCircle } from "lucide-react";
import UserPanelLayout from "@/layouts/UserPanelLayout";

interface AIVoice {
  voiceId: string;
  displayName?: string;
  description?: string;
  languages?: string[];
  gender?: string;
  ageGroup?: string;
  accent?: string;
}

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

// ElevenLabs voice type for dynamic fetching
interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  preview_url: string;
}

interface GenerateResponse {
  success: boolean;
  audioUrl?: string;
  audioBase64?: string;
  audioFormat?: string;
  error?: string;
}

interface CloneResponse {
  success: boolean;
  voice?: { voiceId: string; displayName: string };
  voiceId?: string;
  warnings?: { text: string }[];
  error?: string;
}

interface ClonedVoice {
  voiceId: string;
  displayName: string;
  createdAt: string;
}

const LANG_CODES = [
  { code: "EN_US", name: "English (US)" },
  { code: "ZH_CN", name: "Chinese" },
  { code: "KO_KR", name: "Korean" },
  { code: "JA_JP", name: "Japanese" },
  { code: "RU_RU", name: "Russian" },
  { code: "IT_IT", name: "Italian" },
  { code: "ES_ES", name: "Spanish" },
  { code: "PT_BR", name: "Portuguese" },
  { code: "DE_DE", name: "German" },
  { code: "FR_FR", name: "French" },
  { code: "AR_SA", name: "Arabic" },
  { code: "HI_IN", name: "Hindi" },
];

export default function VoiceCloningInworld() {
  const { toast } = useToast();
  const searchString = useSearch();
  const audioRef = useRef<HTMLAudioElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // Parse URL parameters
  const urlParams = new URLSearchParams(searchString);
  const voiceFromUrl = urlParams.get("voice");
  
  const [text, setText] = useState("");
  const [voice, setVoice] = useState(voiceFromUrl || "Timothy");
  const [language, setLanguage] = useState("en");
  
  // Set voice from URL parameter on initial load
  useEffect(() => {
    if (voiceFromUrl) {
      setVoice(voiceFromUrl);
      // Show toast that voice is pre-selected
      toast({
        title: "Voice Selected",
        description: "Your cloned voice is ready to use!",
      });
    }
  }, []);
  const [speed, setSpeed] = useState([1.0]);
  const [temperature, setTemperature] = useState([0.7]);
  
  const [generatedAudio, setGeneratedAudio] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  
  // Voice cloning states
  const [activeTab, setActiveTab] = useState("tts");
  const [cloneVoiceName, setCloneVoiceName] = useState("");
  const [cloneLangCode, setCloneLangCode] = useState("EN_US");
  const [cloneDescription, setCloneDescription] = useState("");
  const [removeNoise, setRemoveNoise] = useState(true);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioPreview, setAudioPreview] = useState<string | null>(null);
  const [clonedVoices, setClonedVoices] = useState<ClonedVoice[]>(() => {
    const saved = localStorage.getItem("clonedVoices");
    return saved ? JSON.parse(saved) : [];
  });

  // Fetch voices from API based on language
  const { data: voicesData, isLoading: isLoadingVoices } = useQuery<{ success: boolean; voices: AIVoice[] }>({
    queryKey: ['/api/voice-ai/voices', language],
    queryFn: async () => {
      const response = await fetch(`/api/voice-ai/voices?language=${language}`, {
        credentials: 'include'
      });
      return response.json();
    },
  });

  const availableVoices = voicesData?.voices || [];

  // Fetch ElevenLabs official voices with preview URLs
  const { data: elevenlabsData } = useQuery<{ success: boolean; voices: ElevenLabsVoice[] }>({
    queryKey: ['/api/elevenlabs-voices/official'],
    queryFn: async () => {
      const response = await fetch('/api/elevenlabs-voices/official', {
        credentials: 'include'
      });
      return response.json();
    },
  });

  const elevenlabsVoices = elevenlabsData?.voices || [];
  
  // Auto-select first voice when language changes and voices are loaded
  useEffect(() => {
    if (availableVoices.length > 0) {
      const currentVoiceExists = availableVoices.some(v => v.voiceId === voice);
      if (!currentVoiceExists) {
        setVoice(availableVoices[0].voiceId);
      }
    }
  }, [availableVoices, language]);

  const { data: session } = useQuery<{
    authenticated: boolean;
    user?: { username: string; isAdmin: boolean };
  }>({
    queryKey: ['/api/session'],
  });

  const generateMutation = useMutation({
    mutationFn: async () => {
      let voiceToUse = voice;
      let originalElVoice: typeof elevenlabsVoices[0] | null = null;
      
      // Helper function to clone voice
      const cloneVoice = async (elVoice: typeof elevenlabsVoices[0]) => {
        toast({
          title: "Preparing Voice",
          description: `Loading ${elVoice.name} - Please wait...`,
        });
        
        const cloneResponse = await apiRequest("POST", "/api/voice-ai/clone-from-url", {
          name: elVoice.name,
          audioUrl: elVoice.preview_url,
          langCode: "EN_US",
          description: `ElevenLabs ${elVoice.name} voice`,
        });
        const cloneData = await cloneResponse.json() as CloneResponse;
        
        if (cloneData.success && (cloneData.voice?.voiceId || cloneData.voiceId)) {
          const clonedVoiceId = cloneData.voice?.voiceId || cloneData.voiceId!;
          // Remove old clone if exists, then add new one
          const filteredClones = clonedVoices.filter(cv => cv.displayName !== elVoice.name);
          const newClonedVoice: ClonedVoice = {
            voiceId: clonedVoiceId,
            displayName: elVoice.name,
            createdAt: new Date().toISOString(),
          };
          const updatedClones = [...filteredClones, newClonedVoice];
          setClonedVoices(updatedClones);
          localStorage.setItem("clonedVoices", JSON.stringify(updatedClones));
          return clonedVoiceId;
        } else {
          throw new Error(cloneData.error || "Failed to clone voice");
        }
      };
      
      // If ElevenLabs voice selected, clone it first using preview audio
      if (voice.startsWith("elevenlabs:")) {
        const elVoiceId = voice.replace("elevenlabs:", "");
        const elVoice = elevenlabsVoices.find(v => v.voice_id === elVoiceId);
        
        if (elVoice && elVoice.preview_url) {
          originalElVoice = elVoice;
          // Check if already cloned
          const existingClone = clonedVoices.find(cv => cv.displayName === elVoice.name);
          if (existingClone) {
            voiceToUse = existingClone.voiceId;
          } else {
            voiceToUse = await cloneVoice(elVoice);
          }
        }
      } else {
        // Check if it's a cloned voice - find original ElevenLabs voice for re-clone if needed
        const clonedVoice = clonedVoices.find(cv => cv.voiceId === voice);
        if (clonedVoice) {
          const elVoice = elevenlabsVoices.find(v => v.name === clonedVoice.displayName);
          if (elVoice) {
            originalElVoice = elVoice;
          }
        }
      }
      
      // Try to generate audio
      const response = await apiRequest("POST", "/api/voice-ai/generate", {
        text,
        voice: voiceToUse,
        language,
        speed: speed[0],
        temperature: temperature[0],
      });
      
      const data = await response.json() as GenerateResponse;
      
      // If 404 error (voice not found)
      if (data.error && data.error.includes("Not Found")) {
        console.log("[Voice AI] Voice not found, attempting to find and re-clone...");
        
        // Try to find voice in ElevenLabs library
        let voiceToClone = originalElVoice;
        
        if (!voiceToClone) {
          // Get voice name from cloned voices or available voices
          const clonedVoice = clonedVoices.find(cv => cv.voiceId === voiceToUse);
          const voiceName = clonedVoice?.displayName || availableVoices.find(v => v.voiceId === voiceToUse)?.displayName;
          
          if (voiceName) {
            // Search in ElevenLabs library for matching voice
            voiceToClone = elevenlabsVoices.find(v => 
              v.name.toLowerCase() === voiceName.toLowerCase() ||
              v.name.toLowerCase().includes(voiceName.toLowerCase())
            ) || null;
            console.log(`[Voice AI] Found matching voice in ElevenLabs: ${voiceToClone?.name || 'none'}`);
          }
        }
        
        if (voiceToClone && voiceToClone.preview_url) {
          console.log("[Voice AI] Re-cloning voice:", voiceToClone.name);
          const newVoiceId = await cloneVoice(voiceToClone);
          
          // Retry generation with new voice
          const retryResponse = await apiRequest("POST", "/api/voice-ai/generate", {
            text,
            voice: newVoiceId,
            language,
            speed: speed[0],
            temperature: temperature[0],
          });
          return retryResponse.json() as Promise<GenerateResponse>;
        } else {
          // Clear invalid cloned voices
          console.log("[Voice AI] Could not find voice to re-clone, clearing cache");
          setClonedVoices([]);
          localStorage.removeItem("clonedVoices");
          
          return {
            success: false,
            error: "Voice not available. Please select a different voice from ElevenLabs section."
          } as GenerateResponse;
        }
      }
      
      return data;
    },
    onSuccess: (data) => {
      if (data.success && (data.audioUrl || data.audioBase64)) {
        // Handle base64 audio (MP3 format)
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
            console.log("[Voice AI] Audio ready:", blobUrl);
            setGeneratedAudio(blobUrl);
          } catch (e) {
            console.error("[Voice AI] Failed to decode audio:", e);
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

  // Voice cloning mutation
  const cloneMutation = useMutation({
    mutationFn: async () => {
      if (!audioFile) throw new Error("No audio file selected");
      
      // Convert file to base64
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          // Remove data URL prefix to get pure base64
          const base64Data = result.split(',')[1];
          resolve(base64Data);
        };
        reader.onerror = reject;
        reader.readAsDataURL(audioFile);
      });
      
      const response = await apiRequest("POST", "/api/voice-ai/clone", {
        displayName: cloneVoiceName,
        langCode: cloneLangCode,
        audioData: base64,
        description: cloneDescription,
        removeBackgroundNoise: removeNoise,
      });
      return response.json() as Promise<CloneResponse>;
    },
    onSuccess: (data) => {
      if (data.success && data.voiceId) {
        const newVoice: ClonedVoice = {
          voiceId: data.voiceId,
          displayName: cloneVoiceName,
          createdAt: new Date().toISOString(),
        };
        const updatedVoices = [...clonedVoices, newVoice];
        setClonedVoices(updatedVoices);
        localStorage.setItem("clonedVoices", JSON.stringify(updatedVoices));
        
        // Reset form
        setCloneVoiceName("");
        setCloneDescription("");
        setAudioFile(null);
        setAudioPreview(null);
        
        toast({
          title: "Voice Cloned!",
          description: `Voice "${cloneVoiceName}" created successfully. You can now use it in TTS.`,
        });
        
        // Switch to TTS tab
        setActiveTab("tts");
        setVoice(data.voiceId);
      } else {
        toast({
          title: "Cloning Failed",
          description: data.error || "Failed to clone voice",
          variant: "destructive",
        });
      }
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to clone voice",
        variant: "destructive",
      });
    },
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // Validate file type
      if (!file.type.startsWith('audio/')) {
        toast({
          title: "Invalid File",
          description: "Please upload an audio file (MP3, WAV, WebM)",
          variant: "destructive",
        });
        return;
      }
      // Validate file size (max 16MB)
      if (file.size > 16 * 1024 * 1024) {
        toast({
          title: "File Too Large",
          description: "Maximum file size is 16MB",
          variant: "destructive",
        });
        return;
      }
      setAudioFile(file);
      setAudioPreview(URL.createObjectURL(file));
    }
  };

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
      a.download = `voice-audio-${Date.now()}.mp3`;
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
            <h1 className="text-3xl font-bold">ElevenLab TTS</h1>
          </div>
          <p className="text-muted-foreground">
            Ultra-realistic text-to-speech with AI. Clone your voice or use preset voices.
          </p>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <TabsList className="grid w-full max-w-md grid-cols-2">
            <TabsTrigger value="tts" className="flex items-center gap-2" data-testid="tab-tts">
              <Volume2 className="w-4 h-4" />
              Text to Speech
            </TabsTrigger>
            <TabsTrigger value="clone" className="flex items-center gap-2" data-testid="tab-clone">
              <UserCircle className="w-4 h-4" />
              Clone Voice
            </TabsTrigger>
          </TabsList>

          {/* Clone Voice Tab */}
          <TabsContent value="clone" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Mic className="w-5 h-5" />
                  Clone Your Voice
                </CardTitle>
                <CardDescription>
                  Upload 5-15 seconds of clear audio to create your custom voice clone
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-2">
                  <Label htmlFor="voiceName">Voice Name *</Label>
                  <Input
                    id="voiceName"
                    placeholder="My Custom Voice"
                    value={cloneVoiceName}
                    onChange={(e) => setCloneVoiceName(e.target.value)}
                    data-testid="input-voice-name"
                  />
                </div>

                <div className="space-y-2">
                  <Label>Language</Label>
                  <Select value={cloneLangCode} onValueChange={setCloneLangCode}>
                    <SelectTrigger data-testid="select-clone-lang">
                      <SelectValue placeholder="Select language" />
                    </SelectTrigger>
                    <SelectContent>
                      {LANG_CODES.map((lang) => (
                        <SelectItem key={lang.code} value={lang.code}>
                          {lang.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">Description (optional)</Label>
                  <Textarea
                    id="description"
                    placeholder="Describe your voice (tone, accent, use cases...)"
                    value={cloneDescription}
                    onChange={(e) => setCloneDescription(e.target.value)}
                    className="min-h-[80px]"
                    data-testid="input-description"
                  />
                </div>

                <div className="space-y-2">
                  <Label>Audio Sample *</Label>
                  <div 
                    className="border-2 border-dashed rounded-lg p-6 text-center cursor-pointer hover:border-purple-500 transition-colors"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="audio/*"
                      onChange={handleFileChange}
                      className="hidden"
                      data-testid="input-audio-file"
                    />
                    {audioFile ? (
                      <div className="space-y-2">
                        <div className="flex items-center justify-center gap-2 text-green-600">
                          <Upload className="w-5 h-5" />
                          <span>{audioFile.name}</span>
                        </div>
                        {audioPreview && (
                          <audio controls src={audioPreview} className="mx-auto mt-2" />
                        )}
                        <p className="text-sm text-muted-foreground">
                          Click to change file
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <Upload className="w-8 h-8 mx-auto text-muted-foreground" />
                        <p className="font-medium">Click to upload audio</p>
                        <p className="text-sm text-muted-foreground">
                          MP3, WAV, or WebM (5-15 seconds, max 16MB)
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Remove Background Noise</Label>
                    <p className="text-sm text-muted-foreground">
                      Automatically clean up audio
                    </p>
                  </div>
                  <Switch
                    checked={removeNoise}
                    onCheckedChange={setRemoveNoise}
                    data-testid="switch-remove-noise"
                  />
                </div>

                <Button
                  className="w-full bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700"
                  size="lg"
                  onClick={() => cloneMutation.mutate()}
                  disabled={cloneMutation.isPending || !cloneVoiceName || !audioFile}
                  data-testid="button-clone-voice"
                >
                  {cloneMutation.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Preparing...
                    </>
                  ) : (
                    <>
                      <Mic className="w-4 h-4 mr-2" />
                      Clone Voice
                    </>
                  )}
                </Button>

                {clonedVoices.length > 0 && (
                  <div className="pt-4 border-t">
                    <Label className="mb-2 block">Your Cloned Voices</Label>
                    <div className="space-y-2">
                      {clonedVoices.map((v) => (
                        <div
                          key={v.voiceId}
                          className="flex items-center justify-between p-3 bg-muted rounded-lg"
                        >
                          <div>
                            <p className="font-medium">{v.displayName}</p>
                            <p className="text-xs text-muted-foreground">
                              {new Date(v.createdAt).toLocaleDateString()}
                            </p>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setVoice(v.voiceId);
                              setActiveTab("tts");
                            }}
                            data-testid={`button-use-voice-${v.voiceId}`}
                          >
                            Use Voice
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* TTS Tab */}
          <TabsContent value="tts">
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
                <div className="flex justify-between text-sm">
                  <span className={characterCount > 2000 ? "text-amber-600 font-medium" : "text-muted-foreground"}>
                    {characterCount} characters
                    {characterCount > 2000 && ` (${Math.ceil(characterCount / 1800)} chunks)`}
                  </span>
                  <span className="text-muted-foreground">{wordCount} words</span>
                </div>
                {characterCount > 2000 && (
                  <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
                    <p className="text-sm text-amber-600 dark:text-amber-400">
                      Long text detected - will be generated in {Math.ceil(characterCount / 1800)} chunks and combined automatically.
                    </p>
                  </div>
                )}
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
                      <SelectContent position="popper" sideOffset={4} className="max-h-[300px]">
                        {clonedVoices.length > 0 && (
                          <>
                            <div className="px-2 py-1.5 text-xs font-semibold text-purple-600 flex items-center gap-1 sticky top-0 bg-popover z-10">
                              <UserCircle className="w-3 h-3" />
                              Your Cloned Voices
                            </div>
                            {clonedVoices.map((v) => (
                              <SelectItem key={v.voiceId} value={v.voiceId} className="text-purple-600 font-medium">
                                {v.displayName}
                              </SelectItem>
                            ))}
                            <div className="my-1 border-t" />
                          </>
                        )}
                        {elevenlabsVoices.length > 0 && (
                          <>
                            <div className="px-2 py-1.5 text-xs font-semibold text-orange-600 sticky top-0 bg-popover z-10">
                              ElevenLabs Official ({elevenlabsVoices.length})
                            </div>
                            {elevenlabsVoices.map((v) => (
                              <SelectItem key={`el-${v.voice_id}`} value={`elevenlabs:${v.voice_id}`} className="text-orange-600">
                                {v.name}
                              </SelectItem>
                            ))}
                          </>
                        )}
                        <div className="my-1 border-t" />
                        <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground sticky top-0 bg-popover z-10">
                          Preset Voices
                        </div>
                        {isLoadingVoices ? (
                          <div className="px-2 py-3 text-center text-muted-foreground">
                            <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
                            Loading voices...
                          </div>
                        ) : availableVoices.length > 0 ? (
                          availableVoices
                            .filter((v) => !clonedVoices.some(cv => cv.voiceId === v.voiceId || cv.displayName === v.displayName))
                            .map((v) => (
                              <SelectItem key={v.voiceId} value={v.voiceId}>
                                {v.displayName || v.voiceId}
                              </SelectItem>
                            ))
                        ) : (
                          <div className="px-2 py-3 text-center text-muted-foreground text-sm">
                            No voices available for this language
                          </div>
                        )}
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
                        <span>Generated with AI Voice Engine</span>
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
                <div className="space-y-3">
                  <div>
                    <p className="font-semibold text-foreground mb-1">Emotions (start mein likhein):</p>
                    <p className="text-xs mb-1">[happy], [sad], [angry], [surprised], [fearful], [disgusted], [laughing], [whispering]</p>
                    <p className="text-xs italic">Example: [happy] Hello everyone!</p>
                  </div>
                  <div>
                    <p className="font-semibold text-foreground mb-1">Sounds (kahin bhi likhein):</p>
                    <p className="text-xs mb-1">[breathe], [clear_throat], [cough], [laugh], [sigh], [yawn]</p>
                    <p className="text-xs italic">Example: Well [sigh] let me think about it.</p>
                  </div>
                </div>
                <p><strong>Speed:</strong> 0.5x is slower, 1.5x is faster. 1.0x is normal speed.</p>
                <p><strong>Temperature:</strong> Higher values = more expressive/random. Lower = more consistent.</p>
                              </CardContent>
            </Card>

            <Card className="bg-gradient-to-br from-purple-500/10 to-pink-500/10 border-purple-500/20">
              <CardContent className="pt-6">
                <div className="text-center space-y-2">
                  <Sparkles className="w-8 h-8 mx-auto text-purple-500" />
                  <h3 className="font-semibold">AI Voice Engine</h3>
                  <p className="text-sm text-muted-foreground">
                    15 languages supported with ultra-low latency and natural expressiveness.
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
          </TabsContent>
        </Tabs>
      </div>
    </UserPanelLayout>
  );
}
