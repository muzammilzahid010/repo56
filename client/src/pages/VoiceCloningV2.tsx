import { useState, useRef, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { Mic, Upload, Loader2, Play, Pause, Download, Shield, Trash2, Volume2, Copy, CheckCircle } from "lucide-react";
import UserPanelLayout from "@/layouts/UserPanelLayout";
import { useLocation } from "wouter";

interface ClonedVoice {
  id: string;
  name: string;
  description: string;
  language: string;
  createdAt: string;
}

interface CloneResponse {
  success: boolean;
  voice?: ClonedVoice;
  error?: string;
}

interface TestResponse {
  success: boolean;
  audioId?: string;
  error?: string;
}

export default function VoiceCloningV2() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [voiceName, setVoiceName] = useState("");
  const [description, setDescription] = useState("");
  const [language, setLanguage] = useState("en");
  const [mode, setMode] = useState("similarity");
  const [enhance, setEnhance] = useState(false);
  
  const [testText, setTestText] = useState("Hello! This is a test of my cloned voice.");
  const [selectedVoiceId, setSelectedVoiceId] = useState("");
  const [generatedAudio, setGeneratedAudio] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const { data: session } = useQuery<{
    authenticated: boolean;
    user?: { username: string; isAdmin: boolean };
  }>({
    queryKey: ['/api/session'],
  });

  useEffect(() => {
    if (session && (!session.authenticated || !session.user?.isAdmin)) {
      toast({
        title: "Access Denied",
        description: "This tool is only available for administrators",
        variant: "destructive",
      });
      setLocation('/');
    }
  }, [session, setLocation, toast]);

  const { data: voicesData, isLoading: loadingVoices, refetch: refetchVoices } = useQuery<{ voices: ClonedVoice[] }>({
    queryKey: ["/api/voice-cloning-v2/my-voices"],
    enabled: session?.user?.isAdmin === true,
  });

  const cloneMutation = useMutation({
    mutationFn: async () => {
      if (!audioFile) throw new Error("No audio file selected");
      
      const formData = new FormData();
      formData.append("clip", audioFile);
      formData.append("name", voiceName);
      formData.append("description", description);
      formData.append("language", language);
      formData.append("mode", mode);
      formData.append("enhance", enhance.toString());
      
      const response = await fetch("/api/voice-cloning-v2/clone", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      
      return response.json() as Promise<CloneResponse>;
    },
    onSuccess: (data) => {
      if (data.success && data.voice) {
        toast({
          title: "Voice Cloned Successfully",
          description: `Voice "${data.voice.name}" created with ID: ${data.voice.id}`,
        });
        setAudioFile(null);
        setVoiceName("");
        setDescription("");
        if (fileInputRef.current) fileInputRef.current.value = "";
        refetchVoices();
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

  const testMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/voice-cloning-v2/test", {
        voiceId: selectedVoiceId,
        text: testText,
      });
      return response.json() as Promise<TestResponse>;
    },
    onSuccess: (data) => {
      if (data.success && data.audioId) {
        setGeneratedAudio(`/api/tts-v2/audio/${data.audioId}`);
        toast({
          title: "Audio Generated",
          description: "Test audio ready to play",
        });
      } else {
        toast({
          title: "Test Failed",
          description: data.error || "Failed to generate test audio",
          variant: "destructive",
        });
      }
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to test voice",
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (voiceId: string) => {
      const response = await apiRequest("DELETE", `/api/voice-cloning-v2/voice/${voiceId}`, {});
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Voice Deleted",
        description: "Voice removed successfully",
      });
      refetchVoices();
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to delete voice",
        variant: "destructive",
      });
    },
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (!file.type.startsWith("audio/")) {
        toast({
          title: "Invalid File",
          description: "Please upload an audio file (WAV, MP3, etc.)",
          variant: "destructive",
        });
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        toast({
          title: "File Too Large",
          description: "Audio file must be less than 10MB",
          variant: "destructive",
        });
        return;
      }
      setAudioFile(file);
    }
  };

  const togglePlayPause = () => {
    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
      } else {
        audioRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const copyVoiceId = (id: string) => {
    navigator.clipboard.writeText(id);
    setCopiedId(id);
    toast({ title: "Copied", description: "Voice ID copied to clipboard" });
    setTimeout(() => setCopiedId(null), 2000);
  };

  const languages = [
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
  ];

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    
    const handleEnded = () => setIsPlaying(false);
    audio.addEventListener("ended", handleEnded);
    return () => audio.removeEventListener("ended", handleEnded);
  }, [generatedAudio]);

  if (!session?.user?.isAdmin) {
    return null;
  }

  return (
    <UserPanelLayout>
      <div className="p-6 max-w-5xl mx-auto space-y-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-3 bg-gradient-to-br from-pink-500 to-rose-500 rounded-lg">
            <Mic className="w-6 h-6 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold text-foreground">Voice Cloning V2</h1>
              <span className="flex items-center gap-1 px-2 py-0.5 bg-pink-100 dark:bg-pink-900/30 text-pink-700 dark:text-pink-300 text-xs font-medium rounded-full">
                <Shield className="w-3 h-3" />
                Admin Only
              </span>
            </div>
            <p className="text-muted-foreground">Clone voices instantly from 5-10 second audio clips</p>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Upload className="w-5 h-5" />
                Clone New Voice
              </CardTitle>
              <CardDescription>Upload an audio sample to create a voice clone</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Audio Sample (5-10 seconds, WAV/MP3)</Label>
                <div 
                  className="border-2 border-dashed rounded-lg p-6 text-center cursor-pointer hover:border-pink-400 transition-colors"
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
                    <div className="flex items-center justify-center gap-2 text-pink-600">
                      <Mic className="w-5 h-5" />
                      <span className="font-medium">{audioFile.name}</span>
                      <span className="text-sm text-muted-foreground">
                        ({(audioFile.size / 1024 / 1024).toFixed(2)} MB)
                      </span>
                    </div>
                  ) : (
                    <div className="text-muted-foreground">
                      <Upload className="w-8 h-8 mx-auto mb-2" />
                      <p>Click to upload audio file</p>
                      <p className="text-xs mt-1">Best: 5-10 seconds, clear speech, no background noise</p>
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <Label>Voice Name *</Label>
                <Input
                  value={voiceName}
                  onChange={(e) => setVoiceName(e.target.value)}
                  placeholder="e.g., John Narrator"
                  data-testid="input-voice-name"
                />
              </div>

              <div className="space-y-2">
                <Label>Description (optional)</Label>
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Describe the voice characteristics..."
                  rows={2}
                  data-testid="textarea-description"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Language</Label>
                  <Select value={language} onValueChange={setLanguage}>
                    <SelectTrigger data-testid="select-clone-language">
                      <SelectValue />
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
                  <Label>Clone Mode</Label>
                  <Select value={mode} onValueChange={setMode}>
                    <SelectTrigger data-testid="select-clone-mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="similarity">Similarity (Accurate)</SelectItem>
                      <SelectItem value="stability">Stability (Consistent)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex items-center justify-between p-3 bg-muted rounded-lg">
                <div>
                  <Label className="font-medium">Enhance Audio</Label>
                  <p className="text-xs text-muted-foreground">Apply noise reduction (only if audio quality is poor)</p>
                </div>
                <Switch
                  checked={enhance}
                  onCheckedChange={setEnhance}
                  data-testid="switch-enhance"
                />
              </div>

              <Button
                onClick={() => cloneMutation.mutate()}
                disabled={!audioFile || !voiceName.trim() || cloneMutation.isPending}
                className="w-full bg-gradient-to-r from-pink-500 to-rose-500 hover:from-pink-600 hover:to-rose-600"
                data-testid="button-clone-voice"
              >
                {cloneMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Cloning Voice...
                  </>
                ) : (
                  <>
                    <Mic className="w-4 h-4 mr-2" />
                    Clone Voice
                  </>
                )}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Volume2 className="w-5 h-5" />
                Test Cloned Voice
              </CardTitle>
              <CardDescription>Generate speech using your cloned voices</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Select Voice</Label>
                {loadingVoices ? (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading voices...
                  </div>
                ) : (
                  <Select value={selectedVoiceId} onValueChange={setSelectedVoiceId}>
                    <SelectTrigger data-testid="select-test-voice">
                      <SelectValue placeholder="Select a cloned voice" />
                    </SelectTrigger>
                    <SelectContent>
                      {voicesData?.voices && voicesData.voices.length > 0 ? (
                        voicesData.voices.map((voice) => (
                          <SelectItem key={voice.id} value={voice.id}>
                            {voice.name}
                          </SelectItem>
                        ))
                      ) : (
                        <SelectItem value="none" disabled>
                          No cloned voices yet
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                )}
              </div>

              <div className="space-y-2">
                <Label>Test Text</Label>
                <Textarea
                  value={testText}
                  onChange={(e) => setTestText(e.target.value.slice(0, 500))}
                  placeholder="Enter text to speak..."
                  rows={3}
                  data-testid="textarea-test-text"
                />
                <p className="text-xs text-muted-foreground text-right">{testText.length}/500</p>
              </div>

              <Button
                onClick={() => testMutation.mutate()}
                disabled={!selectedVoiceId || !testText.trim() || testMutation.isPending}
                className="w-full"
                variant="outline"
                data-testid="button-test-voice"
              >
                {testMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 mr-2" />
                    Generate Test Audio
                  </>
                )}
              </Button>

              {generatedAudio && (
                <div className="p-4 bg-muted rounded-lg">
                  <audio ref={audioRef} src={generatedAudio} className="hidden" />
                  <div className="flex items-center gap-3">
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={togglePlayPause}
                      data-testid="button-play-test"
                    >
                      {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                    </Button>
                    <span className="text-sm text-muted-foreground flex-1">Test audio ready</span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const link = document.createElement("a");
                        link.href = generatedAudio;
                        link.download = "test-audio.mp3";
                        link.click();
                      }}
                      data-testid="button-download-test"
                    >
                      <Download className="w-4 h-4 mr-1" />
                      Download
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>My Cloned Voices</CardTitle>
            <CardDescription>Manage your voice clones</CardDescription>
          </CardHeader>
          <CardContent>
            {loadingVoices ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : voicesData?.voices && voicesData.voices.length > 0 ? (
              <div className="space-y-3">
                {voicesData.voices.map((voice) => (
                  <div
                    key={voice.id}
                    className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium">{voice.name}</h3>
                        <span className="text-xs px-2 py-0.5 bg-muted rounded">
                          {voice.language?.toUpperCase()}
                        </span>
                      </div>
                      {voice.description && (
                        <p className="text-sm text-muted-foreground mt-1">{voice.description}</p>
                      )}
                      <div className="flex items-center gap-2 mt-2">
                        <code className="text-xs bg-muted px-2 py-1 rounded font-mono">
                          {voice.id}
                        </code>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => copyVoiceId(voice.id)}
                          data-testid={`button-copy-${voice.id}`}
                        >
                          {copiedId === voice.id ? (
                            <CheckCircle className="w-3 h-3 text-green-500" />
                          ) : (
                            <Copy className="w-3 h-3" />
                          )}
                        </Button>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-destructive hover:text-destructive"
                      onClick={() => deleteMutation.mutate(voice.id)}
                      disabled={deleteMutation.isPending}
                      data-testid={`button-delete-${voice.id}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                <Mic className="w-12 h-12 mx-auto mb-3 opacity-50" />
                <p>No cloned voices yet</p>
                <p className="text-sm">Upload an audio sample to create your first voice clone</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </UserPanelLayout>
  );
}
