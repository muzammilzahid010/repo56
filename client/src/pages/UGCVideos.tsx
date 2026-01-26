import { useState, useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { Upload, Video, Image, Loader2, Download, RefreshCw, Sparkles, Play, Layers } from "lucide-react";
import UserPanelLayout from "@/layouts/UserPanelLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface UGCResult {
  success: boolean;
  caption: string;
  ugcImage: string;
  ugcImageMediaId: string;
  operationName: string;
  sceneId: string;
  historyId: number;
  tokenId: string;
  status: string;
}

interface ExtendSceneResult {
  success: boolean;
  operationName: string;
  sceneId: string;
  tokenId: string;
}

interface VideoStatusResult {
  success: boolean;
  status: string;
  isComplete: boolean;
  isFailed: boolean;
  videoUrl: string | null;
  encodedVideo: string | null;
  retryCount?: number;
  isRetrying?: boolean;
  newOperationName?: string;
  newSceneId?: string;
  newTokenId?: string;
  autoRetryExhausted?: boolean;
  autoRetryFailed?: boolean;
}

// Avatar detail options
const genderOptions = [
  { value: "", label: "Select Gender" },
  { value: "woman", label: "Woman" },
  { value: "man", label: "Man" },
];

const ageOptions = [
  { value: "", label: "Select Age" },
  { value: "young (20-25 years old)", label: "Young (20-25)" },
  { value: "adult (25-35 years old)", label: "Adult (25-35)" },
  { value: "middle-aged (35-45 years old)", label: "Middle-aged (35-45)" },
  { value: "mature (45-55 years old)", label: "Mature (45-55)" },
];

const ethnicityOptions = [
  { value: "", label: "Select Ethnicity" },
  { value: "South Asian", label: "South Asian" },
  { value: "Middle Eastern", label: "Middle Eastern" },
  { value: "Caucasian", label: "Caucasian" },
  { value: "African", label: "African" },
  { value: "East Asian", label: "East Asian" },
  { value: "Hispanic/Latino", label: "Hispanic/Latino" },
];

const hairOptions = [
  { value: "", label: "Select Hair" },
  { value: "black hair", label: "Black Hair" },
  { value: "brown hair", label: "Brown Hair" },
  { value: "blonde hair", label: "Blonde Hair" },
  { value: "red hair", label: "Red Hair" },
  { value: "hijab", label: "Hijab" },
  { value: "short hair", label: "Short Hair" },
  { value: "long hair", label: "Long Hair" },
  { value: "curly hair", label: "Curly Hair" },
];

const clothingOptions = [
  { value: "", label: "Select Clothing" },
  { value: "casual clothing", label: "Casual" },
  { value: "professional business attire", label: "Professional/Business" },
  { value: "trendy modern outfit", label: "Trendy/Modern" },
  { value: "traditional ethnic wear", label: "Traditional" },
  { value: "sporty athletic wear", label: "Sporty/Athletic" },
  { value: "elegant dress", label: "Elegant/Formal" },
];

const expressionOptions = [
  { value: "", label: "Select Expression" },
  { value: "smiling naturally", label: "Smiling" },
  { value: "excited and enthusiastic", label: "Excited" },
  { value: "calm and confident", label: "Calm/Confident" },
  { value: "friendly and approachable", label: "Friendly" },
];

export default function UGCVideos() {
  const { toast } = useToast();
  const [uploadedImage, setUploadedImage] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [videoPrompt, setVideoPrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState("IMAGE_ASPECT_RATIO_LANDSCAPE");
  
  // Avatar details state
  const [avatarGender, setAvatarGender] = useState("");
  const [avatarAge, setAvatarAge] = useState("");
  const [avatarEthnicity, setAvatarEthnicity] = useState("");
  const [avatarHair, setAvatarHair] = useState("");
  const [avatarClothing, setAvatarClothing] = useState("");
  const [avatarExpression, setAvatarExpression] = useState("");
  
  // Generate avatar prompt from selections
  const generateAvatarPrompt = useCallback(() => {
    const parts = [];
    if (avatarGender) parts.push(`A ${avatarGender}`);
    if (avatarAge) parts.push(avatarAge);
    if (avatarEthnicity) parts.push(avatarEthnicity);
    if (avatarHair) parts.push(`with ${avatarHair}`);
    if (avatarClothing) parts.push(`wearing ${avatarClothing}`);
    if (avatarExpression) parts.push(avatarExpression);
    
    if (parts.length === 0) return "";
    return parts.join(" ") + " holding and showing the product naturally in a UGC style video";
  }, [avatarGender, avatarAge, avatarEthnicity, avatarHair, avatarClothing, avatarExpression]);
  
  const [ugcResult, setUgcResult] = useState<UGCResult | null>(null);
  const [videoStatus, setVideoStatus] = useState<VideoStatusResult | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  
  // Extend Scene state (Level 1)
  const [extendPrompt, setExtendPrompt] = useState("");
  const [extendedVideoStatus, setExtendedVideoStatus] = useState<VideoStatusResult | null>(null);
  const [isExtendPolling, setIsExtendPolling] = useState(false);
  const [isExtending, setIsExtending] = useState(false);
  
  // Extend Scene state (Level 2 - extend the extended video)
  const [extend2Prompt, setExtend2Prompt] = useState("");
  const [extended2VideoStatus, setExtended2VideoStatus] = useState<VideoStatusResult | null>(null);
  const [isExtend2Polling, setIsExtend2Polling] = useState(false);
  const [isExtending2, setIsExtending2] = useState(false);
  
  // Merge all videos state
  const [isMerging, setIsMerging] = useState(false);

  const handleImageUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      toast({ title: "Invalid file type", description: "Please upload an image file", variant: "destructive" });
      return;
    }

    setImageFile(file);
    const reader = new FileReader();
    reader.onload = (event) => {
      setUploadedImage(event.target?.result as string);
    };
    reader.readAsDataURL(file);
  }, [toast]);

  const generateMutation = useMutation({
    mutationFn: async () => {
      if (!uploadedImage) throw new Error("No image uploaded");
      
      const base64Data = uploadedImage.includes(",") 
        ? uploadedImage.split(",")[1] 
        : uploadedImage;

      const avatarPrompt = generateAvatarPrompt();
      const response = await apiRequest("POST", "/api/ugc/full-flow", {
        imageBase64: base64Data,
        userPrompt: avatarPrompt || undefined,
        videoPrompt: videoPrompt || undefined,
        aspectRatio
      });

      return response.json() as Promise<UGCResult>;
    },
    onSuccess: (data) => {
      setUgcResult(data);
      toast({ title: "UGC generation started", description: "Your video is being generated..." });
      startPolling(data.operationName, data.sceneId, data.tokenId);
    },
    onError: (error: Error) => {
      toast({ title: "Generation failed", description: error.message, variant: "destructive" });
    }
  });

  const checkStatusMutation = useMutation({
    mutationFn: async ({ operationName, sceneId, tokenId, retryCount, ugcImage, prompt }: { 
      operationName: string; 
      sceneId: string; 
      tokenId: string;
      retryCount?: number;
      ugcImage?: string;
      prompt?: string;
    }) => {
      const response = await apiRequest("POST", "/api/ugc/check-video-status", {
        operationName,
        sceneId,
        tokenId,
        retryCount: retryCount || 0,
        ugcImage,
        prompt
      });
      return response.json() as Promise<VideoStatusResult>;
    }
  });

  const startPolling = useCallback((operationName: string, sceneId: string, tokenId: string, retryCount: number = 0) => {
    setIsPolling(true);
    
    const poll = async (currentOpName: string, currentSceneId: string, currentTokenId: string, currentRetryCount: number) => {
      try {
        const result = await checkStatusMutation.mutateAsync({ 
          operationName: currentOpName, 
          sceneId: currentSceneId, 
          tokenId: currentTokenId,
          retryCount: currentRetryCount,
          ugcImage: ugcResult?.ugcImage,
          prompt: videoPrompt || `Make an engaging intro UGC video of this product. ${ugcResult?.caption || ''}`
        });
        setVideoStatus(result);
        
        if (result.isComplete) {
          setIsPolling(false);
          toast({ title: "Video ready!", description: "Your UGC video has been generated successfully" });
        } else if (result.isRetrying && result.newOperationName && result.newTokenId) {
          toast({ title: "Auto-retrying...", description: `Retry attempt ${result.retryCount}/5 with different token` });
          setTimeout(() => poll(
            result.newOperationName!, 
            result.newSceneId || "", 
            result.newTokenId!,
            result.retryCount || 0
          ), 3000);
        } else if (result.isFailed) {
          setIsPolling(false);
          if (result.autoRetryExhausted) {
            toast({ title: "Video generation failed", description: "Max retries exhausted. Please try again.", variant: "destructive" });
          } else {
            toast({ title: "Video generation failed", description: "Please try again", variant: "destructive" });
          }
        } else {
          setTimeout(() => poll(currentOpName, currentSceneId, currentTokenId, currentRetryCount), 5000);
        }
      } catch (error) {
        console.error("Polling error:", error);
        setTimeout(() => poll(currentOpName, currentSceneId, currentTokenId, currentRetryCount), 5000);
      }
    };

    poll(operationName, sceneId, tokenId, retryCount);
  }, [checkStatusMutation, toast, ugcResult, videoPrompt]);

  const handleDownloadVideo = useCallback(() => {
    if (videoStatus?.encodedVideo) {
      const link = document.createElement("a");
      link.href = `data:video/mp4;base64,${videoStatus.encodedVideo}`;
      link.download = `ugc-video-${Date.now()}.mp4`;
      link.click();
    } else if (videoStatus?.videoUrl) {
      window.open(videoStatus.videoUrl, "_blank");
    }
  }, [videoStatus]);

  const handleDownloadExtendedVideo = useCallback(() => {
    if (extendedVideoStatus?.encodedVideo) {
      const link = document.createElement("a");
      link.href = `data:video/mp4;base64,${extendedVideoStatus.encodedVideo}`;
      link.download = `ugc-extended-video-${Date.now()}.mp4`;
      link.click();
    } else if (extendedVideoStatus?.videoUrl) {
      window.open(extendedVideoStatus.videoUrl, "_blank");
    }
  }, [extendedVideoStatus]);

  // Extend Scene polling
  const startExtendPolling = useCallback((operationName: string, sceneId: string, tokenId: string) => {
    setIsExtendPolling(true);
    
    const poll = async () => {
      try {
        const result = await checkStatusMutation.mutateAsync({ operationName, sceneId, tokenId });
        setExtendedVideoStatus(result);
        
        if (result.isComplete) {
          setIsExtendPolling(false);
          toast({ title: "Extended video ready!", description: "Your extended video has been generated successfully" });
        } else if (result.isFailed) {
          setIsExtendPolling(false);
          toast({ title: "Extended video failed", description: "Please try again", variant: "destructive" });
        } else {
          setTimeout(() => poll(), 5000);
        }
      } catch (error) {
        console.error("Extend polling error:", error);
        setTimeout(() => poll(), 5000);
      }
    };

    poll();
  }, [checkStatusMutation, toast]);

  // Extend Scene mutation
  const extendSceneMutation = useMutation({
    mutationFn: async () => {
      if (!videoStatus?.videoUrl) throw new Error("No video to extend");
      
      const defaultPrompt = `extend this ugc video for this product ${ugcResult?.caption || ""}`;
      const prompt = extendPrompt.trim() || defaultPrompt;
      
      const response = await apiRequest("POST", "/api/ugc/extend-scene", {
        videoUrl: videoStatus.videoUrl,
        prompt,
        aspectRatio,
        caption: ugcResult?.caption || "",
        tokenId: ugcResult?.tokenId
      });

      return response.json() as Promise<ExtendSceneResult>;
    },
    onSuccess: (data) => {
      setIsExtending(false);
      toast({ title: "Extending scene...", description: "Your extended video is being generated" });
      startExtendPolling(data.operationName, data.sceneId, data.tokenId);
    },
    onError: (error: Error) => {
      setIsExtending(false);
      toast({ title: "Extend failed", description: error.message, variant: "destructive" });
    }
  });

  const handleExtendScene = useCallback(() => {
    setIsExtending(true);
    setExtendedVideoStatus(null);
    extendSceneMutation.mutate();
  }, [extendSceneMutation]);

  // Level 2 extend - download handler
  const handleDownloadExtended2Video = useCallback(() => {
    if (extended2VideoStatus?.encodedVideo) {
      const link = document.createElement("a");
      link.href = `data:video/mp4;base64,${extended2VideoStatus.encodedVideo}`;
      link.download = `ugc-extended2-video-${Date.now()}.mp4`;
      link.click();
    } else if (extended2VideoStatus?.videoUrl) {
      window.open(extended2VideoStatus.videoUrl, "_blank");
    }
  }, [extended2VideoStatus]);

  // Level 2 extend polling
  const startExtend2Polling = useCallback((operationName: string, sceneId: string, tokenId: string) => {
    setIsExtend2Polling(true);
    
    const poll = async () => {
      try {
        const result = await checkStatusMutation.mutateAsync({ operationName, sceneId, tokenId });
        setExtended2VideoStatus(result);
        
        if (result.isComplete) {
          setIsExtend2Polling(false);
          toast({ title: "Extended video ready!", description: "Your second extended video has been generated" });
        } else if (result.isFailed) {
          setIsExtend2Polling(false);
          toast({ title: "Extended video failed", description: "Please try again", variant: "destructive" });
        } else {
          setTimeout(() => poll(), 5000);
        }
      } catch (error) {
        console.error("Extend2 polling error:", error);
        setTimeout(() => poll(), 5000);
      }
    };

    poll();
  }, [checkStatusMutation, toast]);

  // Level 2 extend mutation
  const extendScene2Mutation = useMutation({
    mutationFn: async () => {
      if (!extendedVideoStatus?.videoUrl) throw new Error("No extended video to extend");
      
      const defaultPrompt = `extend this ugc video for this product ${ugcResult?.caption || ""}`;
      const prompt = extend2Prompt.trim() || defaultPrompt;
      
      const response = await apiRequest("POST", "/api/ugc/extend-scene", {
        videoUrl: extendedVideoStatus.videoUrl,
        prompt,
        aspectRatio,
        caption: ugcResult?.caption || "",
        tokenId: ugcResult?.tokenId
      });

      return response.json() as Promise<ExtendSceneResult>;
    },
    onSuccess: (data) => {
      setIsExtending2(false);
      toast({ title: "Extending scene...", description: "Your second extended video is being generated" });
      startExtend2Polling(data.operationName, data.sceneId, data.tokenId);
    },
    onError: (error: Error) => {
      setIsExtending2(false);
      toast({ title: "Extend failed", description: error.message, variant: "destructive" });
    }
  });

  const handleExtendScene2 = useCallback(() => {
    setIsExtending2(true);
    setExtended2VideoStatus(null);
    extendScene2Mutation.mutate();
  }, [extendScene2Mutation]);

  const handleMergeAllVideos = useCallback(async () => {
    const videoUrls: string[] = [];
    
    if (videoStatus?.videoUrl) {
      videoUrls.push(videoStatus.videoUrl);
    }
    if (extendedVideoStatus?.videoUrl) {
      videoUrls.push(extendedVideoStatus.videoUrl);
    }
    if (extended2VideoStatus?.videoUrl) {
      videoUrls.push(extended2VideoStatus.videoUrl);
    }
    
    if (videoUrls.length < 2) {
      toast({ title: "Not enough videos", description: "You need at least 2 videos to merge", variant: "destructive" });
      return;
    }
    
    setIsMerging(true);
    
    try {
      const response = await fetch("/api/ugc/merge-all-videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ videoUrls })
      });
      
      // Get as blob first
      const blob = await response.blob();
      
      // Check if it's a video (size > 1000 bytes means it's probably a video, not JSON error)
      if (blob.size > 1000 && (blob.type.includes("video") || blob.type === "" || blob.type === "application/octet-stream")) {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `merged-ugc-video-${Date.now()}.mp4`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        toast({ title: "Download started!", description: "Your merged video is downloading" });
      } else {
        // Small response = likely JSON error
        const text = await blob.text();
        try {
          const errorData = JSON.parse(text);
          throw new Error(errorData.message || errorData.error || "Merge failed");
        } catch {
          throw new Error(text || "Merge failed");
        }
      }
    } catch (error) {
      toast({ title: "Merge failed", description: error instanceof Error ? error.message : "Unknown error", variant: "destructive" });
    } finally {
      setIsMerging(false);
    }
  }, [videoStatus, extendedVideoStatus, extended2VideoStatus, toast]);

  const handleReset = useCallback(() => {
    setUploadedImage(null);
    setImageFile(null);
    setVideoPrompt("");
    setAvatarGender("");
    setAvatarAge("");
    setAvatarEthnicity("");
    setAvatarHair("");
    setAvatarClothing("");
    setAvatarExpression("");
    setUgcResult(null);
    setVideoStatus(null);
    setIsPolling(false);
    setExtendPrompt("");
    setExtendedVideoStatus(null);
    setIsExtendPolling(false);
    setIsExtending(false);
    setExtend2Prompt("");
    setExtended2VideoStatus(null);
    setIsExtend2Polling(false);
    setIsExtending2(false);
    setIsMerging(false);
  }, []);

  return (
    <UserPanelLayout>
      <div className="container mx-auto p-6 max-w-4xl">
        <div className="mb-8">
          <h1 className="text-3xl font-bold flex items-center gap-2" data-testid="text-page-title">
            <Sparkles className="h-8 w-8 text-primary" />
            UGC Video Generator
          </h1>
          <p className="text-muted-foreground mt-2">
            Upload a product image to generate authentic user-generated content videos
          </p>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Upload className="h-5 w-5" />
                Upload Product Image
              </CardTitle>
              <CardDescription>
                Upload your product image to start the UGC generation process
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div 
                className="border-2 border-dashed rounded-lg p-6 text-center hover-elevate cursor-pointer transition-colors"
                onClick={() => document.getElementById("image-upload")?.click()}
                data-testid="button-upload-image"
              >
                {uploadedImage ? (
                  <img 
                    src={uploadedImage} 
                    alt="Uploaded product" 
                    className="max-h-48 mx-auto rounded-lg object-contain"
                    data-testid="img-uploaded-product"
                  />
                ) : (
                  <div className="space-y-2">
                    <Image className="h-12 w-12 mx-auto text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">Click to upload product image</p>
                    <p className="text-xs text-muted-foreground">PNG, JPG up to 10MB</p>
                  </div>
                )}
                <input
                  id="image-upload"
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleImageUpload}
                  data-testid="input-image-file"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="aspect-ratio">Aspect Ratio</Label>
                <Select value={aspectRatio} onValueChange={setAspectRatio}>
                  <SelectTrigger data-testid="select-aspect-ratio">
                    <SelectValue placeholder="Select aspect ratio" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="IMAGE_ASPECT_RATIO_LANDSCAPE">Landscape (16:9)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-3">
                <Label className="text-base font-semibold">Avatar Details (Optional)</Label>
                <p className="text-xs text-muted-foreground">Select options to customize the person in your UGC video</p>
                
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Gender</Label>
                    <Select value={avatarGender} onValueChange={setAvatarGender}>
                      <SelectTrigger data-testid="select-avatar-gender">
                        <SelectValue placeholder="Select Gender" />
                      </SelectTrigger>
                      <SelectContent>
                        {genderOptions.map(opt => (
                          <SelectItem key={opt.value || "empty"} value={opt.value || "none"}>{opt.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  
                  <div className="space-y-1">
                    <Label className="text-xs">Age</Label>
                    <Select value={avatarAge} onValueChange={setAvatarAge}>
                      <SelectTrigger data-testid="select-avatar-age">
                        <SelectValue placeholder="Select Age" />
                      </SelectTrigger>
                      <SelectContent>
                        {ageOptions.map(opt => (
                          <SelectItem key={opt.value || "empty"} value={opt.value || "none"}>{opt.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  
                  <div className="space-y-1">
                    <Label className="text-xs">Ethnicity</Label>
                    <Select value={avatarEthnicity} onValueChange={setAvatarEthnicity}>
                      <SelectTrigger data-testid="select-avatar-ethnicity">
                        <SelectValue placeholder="Select Ethnicity" />
                      </SelectTrigger>
                      <SelectContent>
                        {ethnicityOptions.map(opt => (
                          <SelectItem key={opt.value || "empty"} value={opt.value || "none"}>{opt.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  
                  <div className="space-y-1">
                    <Label className="text-xs">Hair</Label>
                    <Select value={avatarHair} onValueChange={setAvatarHair}>
                      <SelectTrigger data-testid="select-avatar-hair">
                        <SelectValue placeholder="Select Hair" />
                      </SelectTrigger>
                      <SelectContent>
                        {hairOptions.map(opt => (
                          <SelectItem key={opt.value || "empty"} value={opt.value || "none"}>{opt.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  
                  <div className="space-y-1">
                    <Label className="text-xs">Clothing</Label>
                    <Select value={avatarClothing} onValueChange={setAvatarClothing}>
                      <SelectTrigger data-testid="select-avatar-clothing">
                        <SelectValue placeholder="Select Clothing" />
                      </SelectTrigger>
                      <SelectContent>
                        {clothingOptions.map(opt => (
                          <SelectItem key={opt.value || "empty"} value={opt.value || "none"}>{opt.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  
                  <div className="space-y-1">
                    <Label className="text-xs">Expression</Label>
                    <Select value={avatarExpression} onValueChange={setAvatarExpression}>
                      <SelectTrigger data-testid="select-avatar-expression">
                        <SelectValue placeholder="Select Expression" />
                      </SelectTrigger>
                      <SelectContent>
                        {expressionOptions.map(opt => (
                          <SelectItem key={opt.value || "empty"} value={opt.value || "none"}>{opt.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                
                {generateAvatarPrompt() && (
                  <p className="text-xs text-muted-foreground bg-muted p-2 rounded">
                    Preview: {generateAvatarPrompt()}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="video-prompt">Video Prompt (Optional)</Label>
                <Textarea
                  id="video-prompt"
                  placeholder="e.g., Make an engaging intro video showing the product benefits..."
                  value={videoPrompt}
                  onChange={(e) => setVideoPrompt(e.target.value)}
                  rows={3}
                  data-testid="input-video-prompt"
                />
              </div>

              <div className="flex gap-2">
                <Button
                  className="flex-1"
                  onClick={() => generateMutation.mutate()}
                  disabled={!uploadedImage || generateMutation.isPending || isPolling}
                  data-testid="button-generate"
                >
                  {generateMutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Processing...
                    </>
                  ) : (
                    <>
                      <Video className="h-4 w-4 mr-2" />
                      Generate UGC Video
                    </>
                  )}
                </Button>
                {(ugcResult || uploadedImage) && (
                  <Button variant="outline" onClick={handleReset} data-testid="button-reset">
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Video className="h-5 w-5" />
                Result
              </CardTitle>
              <CardDescription>
                Generated UGC image and video will appear here
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {!ugcResult && !isPolling && (
                <div className="border-2 border-dashed rounded-lg p-12 text-center">
                  <Sparkles className="h-12 w-12 mx-auto text-muted-foreground mb-2" />
                  <p className="text-sm text-muted-foreground">Upload an image and click generate to see results</p>
                </div>
              )}

              {ugcResult?.ugcImage && (
                <div className="space-y-2">
                  <Label>Generated UGC Image</Label>
                  <img 
                    src={`data:image/png;base64,${ugcResult.ugcImage}`}
                    alt="Generated UGC"
                    className="w-full rounded-lg object-cover"
                    data-testid="img-generated-ugc"
                  />
                </div>
              )}

              {ugcResult?.caption && (
                <div className="space-y-2">
                  <Label>Product Caption</Label>
                  <p className="text-sm text-muted-foreground bg-muted p-3 rounded-lg" data-testid="text-caption">
                    {ugcResult.caption.substring(0, 200)}...
                  </p>
                </div>
              )}

              {isPolling && (
                <div className="flex items-center justify-center gap-2 p-4 bg-muted rounded-lg">
                  <Loader2 className="h-5 w-5 animate-spin text-primary" />
                  <span className="text-sm">Generating video... This may take a few minutes</span>
                </div>
              )}

              {videoStatus?.isComplete && (
                <div className="space-y-4">
                  <div className="p-4 bg-green-500/10 border border-green-500/20 rounded-lg text-center">
                    <p className="text-green-600 dark:text-green-400 font-medium">Video generated successfully!</p>
                  </div>

                  {/* Merge All Videos Button - shows when at least 2 videos exist */}
                  {extendedVideoStatus?.isComplete && (
                    <div className="p-4 bg-gradient-to-r from-purple-500/10 to-blue-500/10 border border-purple-500/20 rounded-lg space-y-3">
                      <Label className="text-base font-semibold flex items-center gap-2">
                        <Layers className="h-4 w-4" />
                        Download All Videos (Merged)
                      </Label>
                      <p className="text-sm text-muted-foreground">
                        Merge all videos in sequence (first video full, others trimmed 1s from start)
                      </p>
                      <Button 
                        className="w-full bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700"
                        onClick={handleMergeAllVideos}
                        disabled={isMerging}
                        data-testid="button-merge-all"
                      >
                        {isMerging ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Merging Videos... Please wait
                          </>
                        ) : (
                          <>
                            <Download className="h-4 w-4 mr-2" />
                            Merge & Download All ({[videoStatus?.videoUrl, extendedVideoStatus?.videoUrl, extended2VideoStatus?.videoUrl].filter(Boolean).length} videos)
                          </>
                        )}
                      </Button>
                    </div>
                  )}
                  
                  {videoStatus.videoUrl && (
                    <div className="space-y-2">
                      <Label>Generated Video</Label>
                      <video 
                        src={videoStatus.videoUrl}
                        controls
                        autoPlay
                        loop
                        className="w-full rounded-lg"
                        data-testid="video-preview"
                      />
                    </div>
                  )}
                  
                  <Button className="w-full" onClick={handleDownloadVideo} data-testid="button-download-video">
                    <Download className="h-4 w-4 mr-2" />
                    Download Video
                  </Button>

                  {/* Extended Video 1 Result */}
                  {extendedVideoStatus?.isComplete && (
                    <div className="border-t pt-4 mt-4 space-y-3">
                      <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg text-center">
                        <p className="text-blue-600 dark:text-blue-400 font-medium">Extended video ready!</p>
                      </div>
                      {extendedVideoStatus.videoUrl && (
                        <div className="space-y-2">
                          <Label>Extended Video</Label>
                          <video 
                            src={extendedVideoStatus.videoUrl}
                            controls
                            autoPlay
                            loop
                            className="w-full rounded-lg"
                            data-testid="video-extended-preview"
                          />
                        </div>
                      )}
                      <Button className="w-full" onClick={handleDownloadExtendedVideo} data-testid="button-download-extended">
                        <Download className="h-4 w-4 mr-2" />
                        Download Extended Video
                      </Button>
                    </div>
                  )}

                  {extendedVideoStatus?.isFailed && (
                    <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-center">
                      <p className="text-red-600 dark:text-red-400 text-sm">Extended video generation failed</p>
                    </div>
                  )}

                  {/* Extended Video 2 Result */}
                  {extended2VideoStatus?.isComplete && (
                    <div className="border-t pt-4 mt-4 space-y-3">
                      <div className="p-3 bg-purple-500/10 border border-purple-500/20 rounded-lg text-center">
                        <p className="text-purple-600 dark:text-purple-400 font-medium">Second extended video ready!</p>
                      </div>
                      {extended2VideoStatus.videoUrl && (
                        <div className="space-y-2">
                          <Label>Extended Video 2</Label>
                          <video 
                            src={extended2VideoStatus.videoUrl}
                            controls
                            autoPlay
                            loop
                            className="w-full rounded-lg"
                            data-testid="video-extended2-preview"
                          />
                        </div>
                      )}
                      <Button className="w-full" onClick={handleDownloadExtended2Video} data-testid="button-download-extended2">
                        <Download className="h-4 w-4 mr-2" />
                        Download Extended Video 2
                      </Button>
                    </div>
                  )}

                  {extended2VideoStatus?.isFailed && (
                    <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-center">
                      <p className="text-red-600 dark:text-red-400 text-sm">Extended video 2 generation failed</p>
                    </div>
                  )}

                  {/* Extend Scene Section - Only shows after LAST video (max 2 extensions) */}
                  {!extended2VideoStatus?.isComplete && !isExtend2Polling && (
                    <div className="border-t pt-4 mt-4 space-y-3">
                      <Label className="text-base font-semibold flex items-center gap-2">
                        <Play className="h-4 w-4" />
                        {extendedVideoStatus?.isComplete ? "Extend Scene Again" : "Extend Scene"}
                      </Label>
                      <p className="text-sm text-muted-foreground">
                        {extendedVideoStatus?.isComplete 
                          ? "Continue extending with another scene (final extension)" 
                          : "Extend your video with a continuation scene"}
                      </p>
                      <Input
                        placeholder="Default: extend this ugc video for this product..."
                        value={extendedVideoStatus?.isComplete ? extend2Prompt : extendPrompt}
                        onChange={(e) => extendedVideoStatus?.isComplete 
                          ? setExtend2Prompt(e.target.value) 
                          : setExtendPrompt(e.target.value)}
                        data-testid={extendedVideoStatus?.isComplete ? "input-extend2-prompt" : "input-extend-prompt"}
                      />
                      <Button 
                        className="w-full" 
                        variant="secondary"
                        onClick={extendedVideoStatus?.isComplete ? handleExtendScene2 : handleExtendScene}
                        disabled={extendedVideoStatus?.isComplete 
                          ? (isExtending2 || isExtend2Polling) 
                          : (isExtending || isExtendPolling)}
                        data-testid={extendedVideoStatus?.isComplete ? "button-extend-scene-2" : "button-extend-scene"}
                      >
                        {(extendedVideoStatus?.isComplete ? (isExtending2 || isExtend2Polling) : (isExtending || isExtendPolling)) ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            {(extendedVideoStatus?.isComplete ? isExtend2Polling : isExtendPolling) 
                              ? "Generating Extended Video..." 
                              : "Processing..."}
                          </>
                        ) : (
                          <>
                            <Play className="h-4 w-4 mr-2" />
                            Extend Scene {extendedVideoStatus?.isComplete && "(Final)"}
                          </>
                        )}
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {videoStatus?.isFailed && (
                <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-lg text-center">
                  <p className="text-red-600 dark:text-red-400 font-medium">Video generation failed</p>
                  <Button variant="outline" className="mt-2" onClick={handleReset}>
                    Try Again
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </UserPanelLayout>
  );
}
