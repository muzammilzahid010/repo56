import { useState, useRef, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import UserPanelLayout from "@/layouts/UserPanelLayout";
import AnimatedDotsBackground from "@/components/AnimatedDotsBackground";

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import CircularProgress from '@mui/material/CircularProgress';
import LinearProgress from '@mui/material/LinearProgress';
import IconButton from '@mui/material/IconButton';
import Grid from '@mui/material/Grid';
import Card from '@mui/material/Card';
import CardMedia from '@mui/material/CardMedia';
import Chip from '@mui/material/Chip';
import { Users, Sparkles, X, Upload, Image as ImageIcon, Download, Zap, CheckCircle, AlertCircle, Loader2, Film } from "lucide-react";

interface GeneratedResult {
  prompt: string;
  status: 'pending' | 'uploading_character' | 'generating_image' | 'generating_video' | 'polling' | 'completed' | 'failed';
  imageUrl?: string;
  videoUrl?: string;
  error?: string;
  historyId?: string;
}

interface ToolMaintenance {
  veoGeneratorActive: boolean;
  bulkGeneratorActive: boolean;
  textToImageActive: boolean;
  imageToVideoActive: boolean;
  scriptCreatorActive: boolean;
  characterConsistencyActive: boolean;
}

export default function CharacterConsistent() {
  const [characterImageData, setCharacterImageData] = useState<{ base64: string; mimeType: string } | null>(null);
  const [characterImagePreview, setCharacterImagePreview] = useState<string | null>(null);
  const [prompts, setPrompts] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [results, setResults] = useState<GeneratedResult[]>([]);
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const currentBatchIdRef = useRef<string | null>(null);
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [isPolling, setIsPolling] = useState(false);

  const { data: maintenanceData } = useQuery<{ maintenance: ToolMaintenance }>({
    queryKey: ["/api/tool-maintenance"],
  });

  const { data: session, isLoading: sessionLoading } = useQuery<{
    authenticated: boolean;
    user?: { id: string; username: string; isAdmin: boolean; planType?: string };
  }>({
    queryKey: ["/api/session"],
  });

  if (maintenanceData?.maintenance && !maintenanceData.maintenance.characterConsistencyActive) {
    return (
      <UserPanelLayout>
        <Box sx={{ minHeight: '80vh', display: 'flex', alignItems: 'center', justifyContent: 'center', p: 4 }}>
          <Paper sx={{ p: 6, textAlign: 'center', maxWidth: 500, background: 'white', border: '1px solid rgba(26, 26, 46, 0.3)', boxShadow: '0 4px 20px rgba(0,0,0,0.1)' }}>
            <Users className="w-16 h-16 mx-auto text-gray-700 mb-4" />
            <Typography variant="h5" sx={{ color: '#7c3aed', fontWeight: 600, mb: 2 }}>Under Maintenance</Typography>
            <Typography sx={{ color: '#64748b' }}>Character Consistent Videos is currently under maintenance.</Typography>
          </Paper>
        </Box>
      </UserPanelLayout>
    );
  }

  if (!sessionLoading && session && !session.authenticated) {
    setLocation("/login");
    return null;
  }

  // Check if user has Empire plan or is admin
  const userPlan = session?.user?.planType;
  const isAdmin = session?.user?.isAdmin === true;
  const hasAccess = userPlan === 'empire' || isAdmin;

  // Only show access denied after session is fully loaded
  if (!sessionLoading && session?.authenticated && session?.user && !hasAccess) {
    return (
      <UserPanelLayout>
        <AnimatedDotsBackground />
        <Box sx={{ position: 'relative', zIndex: 1, minHeight: '80vh', display: 'flex', alignItems: 'center', justifyContent: 'center', p: 4 }}>
          <Paper sx={{ 
            p: 6, 
            textAlign: 'center', 
            maxWidth: 500, 
            background: 'white', 
            border: '1px solid rgba(26, 26, 46, 0.3)', 
            boxShadow: '0 8px 30px rgba(26, 26, 46, 0.15)',
            borderRadius: 3,
          }}>
            <Box sx={{ 
              p: 2, 
              borderRadius: 2, 
              background: 'linear-gradient(135deg, #1a1a2e 0%, #374151 100%)',
              width: 64,
              height: 64,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              mx: 'auto',
              mb: 3,
            }}>
              <Users className="w-8 h-8 text-white" />
            </Box>
            <Typography variant="h5" sx={{ 
              fontWeight: 700, 
              mb: 2,
              background: 'linear-gradient(135deg, #0f172a 0%, #1f2937 100%)',
              backgroundClip: 'text',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}>
              Empire Plan Required
            </Typography>
            <Typography sx={{ color: '#64748b', mb: 3 }}>
              Character Consistency is an exclusive feature for Empire plan users. Upgrade to unlock bulk character-consistent video generation.
            </Typography>
            <Button
              variant="contained"
              onClick={() => setLocation('/pricing')}
              sx={{ 
                background: 'linear-gradient(135deg, #1a1a2e 0%, #374151 100%)',
                fontWeight: 600,
                px: 4,
                py: 1.5,
                borderRadius: 2,
                '&:hover': { 
                  background: 'linear-gradient(135deg, #0f172a 0%, #1f2937 100%)',
                },
              }}
              data-testid="button-upgrade-plan"
            >
              Upgrade to Empire
            </Button>
          </Paper>
        </Box>
      </UserPanelLayout>
    );
  }

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast({ title: "Invalid file", description: "Please upload an image file", variant: "destructive" });
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      toast({ title: "File too large", description: "Image must be less than 10MB", variant: "destructive" });
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      const base64 = dataUrl.split(',')[1];
      setCharacterImageData({ base64, mimeType: file.type });
      setCharacterImagePreview(dataUrl);
    };
    reader.readAsDataURL(file);
  };

  const clearImage = () => {
    setCharacterImageData(null);
    setCharacterImagePreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const parsePrompts = (): string[] => {
    return prompts
      .split('\n')
      .map(p => p.trim())
      .filter(p => p.length >= 3);
  };

  // Polling fallback: When SSE stream ends but videos are not complete, poll video-history API
  const startPollingFallback = useCallback(async () => {
    const batchId = currentBatchIdRef.current;
    if (!batchId) return;
    
    setIsPolling(true);
    console.log('[CharacterConsistent] Starting polling fallback for batch:', batchId);
    
    const pollVideoHistory = async () => {
      try {
        const response = await fetch(`/api/video-history?limit=100`, {
          credentials: 'include'
        });
        
        if (!response.ok) return;
        
        const data = await response.json();
        const videos = data.videos || [];
        
        // Filter videos for this batch
        const batchVideos = videos.filter((v: any) => v.batchId === batchId);
        
        if (batchVideos.length === 0) return;
        
        // Update results based on video history
        setResults(prev => {
          const updated = [...prev];
          batchVideos.forEach((video: any) => {
            // Match by prompt or sceneNumber
            const sceneIndex = (video.sceneNumber || 1) - 1;
            if (sceneIndex >= 0 && sceneIndex < updated.length) {
              if (video.status === 'completed' && video.videoUrl) {
                updated[sceneIndex] = {
                  ...updated[sceneIndex],
                  status: 'completed',
                  videoUrl: video.videoUrl,
                  historyId: video.id
                };
              } else if (video.status === 'failed') {
                updated[sceneIndex] = {
                  ...updated[sceneIndex],
                  status: 'failed',
                  error: video.error || 'Video generation failed'
                };
              }
            }
          });
          return updated;
        });
        
        // Check if all videos are complete
        const completedCount = batchVideos.filter((v: any) => v.status === 'completed' || v.status === 'failed').length;
        
        setResults(prev => {
          const incompleteCount = prev.filter(r => r.status !== 'completed' && r.status !== 'failed').length;
          if (incompleteCount === 0) {
            // All done - stop polling
            if (pollingIntervalRef.current) {
              clearInterval(pollingIntervalRef.current);
              pollingIntervalRef.current = null;
            }
            setIsPolling(false);
            setIsGenerating(false);
            console.log('[CharacterConsistent] Polling complete - all videos finished');
          }
          return prev;
        });
        
      } catch (error) {
        console.error('[CharacterConsistent] Polling error:', error);
      }
    };
    
    // Poll immediately, then every 5 seconds
    pollVideoHistory();
    pollingIntervalRef.current = setInterval(pollVideoHistory, 5000);
  }, []);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
    };
  }, []);

  const handleGenerate = async () => {
    const promptList = parsePrompts();
    
    if (!characterImageData) {
      toast({ title: "No character image", description: "Please upload a character reference image", variant: "destructive" });
      return;
    }

    if (promptList.length === 0) {
      toast({ title: "No prompts", description: "Please enter at least one prompt", variant: "destructive" });
      return;
    }

    if (promptList.length > 50) {
      toast({ title: "Too many prompts", description: "Maximum 50 prompts per batch", variant: "destructive" });
      return;
    }

    // CRITICAL: Cancel any existing generation before starting new one
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    
    // Clear any existing polling
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
    setIsPolling(false);
    currentBatchIdRef.current = null;

    // Create new AbortController for this batch
    const controller = new AbortController();
    abortControllerRef.current = controller;

    // IMMEDIATELY create boxes for all prompts (like bulk generator)
    setIsGenerating(true);
    setResults(promptList.map(prompt => ({ prompt, status: 'pending' })));

    try {
      const response = await fetch("/api/character-video-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        signal: controller.signal,
        body: JSON.stringify({
          prompts: promptList,
          aspectRatio: "IMAGE_ASPECT_RATIO_LANDSCAPE",
          characterImageBase64: characterImageData.base64,
          characterImageMimeType: characterImageData.mimeType,
          imagesOnly: false,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to start generation');
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response stream');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const chunk of lines) {
          if (!chunk.trim()) continue;
          
          const eventMatch = chunk.match(/^event: (\w+)/);
          const dataMatch = chunk.match(/^data: (.+)$/m);
          
          if (eventMatch && dataMatch) {
            const eventType = eventMatch[1];
            try {
              const data = JSON.parse(dataMatch[1]);
              
              if (eventType === 'batch_started') {
                // Capture batchId for polling fallback
                currentBatchIdRef.current = data.batchId;
                console.log('[CharacterConsistent] Batch started:', data.batchId);
              } else if (eventType === 'progress') {
                setResults(prev => prev.map((item, idx) => {
                  if (idx === data.index) {
                    return { 
                      ...item, 
                      status: data.phase as GeneratedResult['status'],
                      imageUrl: data.imageUrl || item.imageUrl,
                    };
                  }
                  return item;
                }));
              } else if (eventType === 'result') {
                setResults(prev => prev.map((item, idx) => {
                  if (idx === data.index) {
                    return {
                      ...item,
                      status: data.status === 'completed' ? 'completed' : 'failed',
                      imageUrl: data.imageUrl || item.imageUrl,
                      videoUrl: data.videoUrl,
                      error: data.error,
                      historyId: data.historyId,
                    };
                  }
                  return item;
                }));
              } else if (eventType === 'complete') {
                toast({ title: "Generation complete", description: data.message });
              } else if (eventType === 'error') {
                // Mark all pending videos as failed with the error message
                setResults(prev => prev.map(item => {
                  if (item.status === 'pending' || item.status === 'uploading_character') {
                    return { ...item, status: 'failed', error: data.error };
                  }
                  return item;
                }));
                setIsGenerating(false);
                toast({ title: "Error", description: data.error, variant: "destructive" });
                return; // Exit the loop, don't throw
              }
            } catch (parseError) {
              console.error('SSE parse error:', parseError);
            }
          }
        }
      }

    } catch (error: any) {
      // Don't show error toast if request was aborted (user started new batch)
      if (error.name === 'AbortError') {
        console.log('[CharacterConsistent] Previous generation aborted for new batch');
        return;
      }
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      // Only set isGenerating to false if this controller is still active
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
        
        // Check if there are incomplete videos - if so, start polling fallback
        // Note: We check results in a setTimeout to get the latest state
        setTimeout(() => {
          setResults(prev => {
            const incompleteCount = prev.filter(r => 
              r.status !== 'completed' && r.status !== 'failed'
            ).length;
            
            if (incompleteCount > 0 && currentBatchIdRef.current) {
              console.log(`[CharacterConsistent] Stream ended with ${incompleteCount} incomplete videos - starting polling fallback`);
              startPollingFallback();
            } else {
              setIsGenerating(false);
            }
            return prev;
          });
        }, 100);
      }
    }
  };

  const completedCount = results.filter(r => r.status === 'completed').length;
  const failedCount = results.filter(r => r.status === 'failed').length;
  const activeCount = results.filter(r => !['pending', 'completed', 'failed'].includes(r.status)).length;

  const getStatusIcon = (status: string) => {
    if (status === 'completed') return <CheckCircle className="w-4 h-4 text-emerald-500" />;
    if (status === 'failed') return <AlertCircle className="w-4 h-4 text-red-500" />;
    if (status === 'pending') return <div className="w-4 h-4 rounded-full bg-gray-300" />;
    return <Loader2 className="w-4 h-4 text-gray-700 animate-spin" />;
  };

  const getStatusColor = (status: string) => {
    if (status === 'completed') return '#22c55e';
    if (status === 'failed') return '#ef4444';
    if (status === 'pending') return '#9ca3af';
    return '#1a1a2e';
  };

  return (
    <UserPanelLayout>
      <AnimatedDotsBackground />
      <Box sx={{ position: 'relative', zIndex: 1, p: { xs: 2, md: 4 }, maxWidth: 1400, mx: 'auto' }}>
        <Box sx={{ 
          display: 'flex', 
          alignItems: 'center', 
          gap: 3, 
          mb: 4,
          p: 3,
          borderRadius: 3,
          background: 'linear-gradient(135deg, rgba(26, 26, 46, 0.1) 0%, rgba(55, 65, 81, 0.1) 100%)',
          border: '1px solid rgba(26, 26, 46, 0.2)',
        }}>
          <Box sx={{ 
            p: 2, 
            borderRadius: 2, 
            background: 'linear-gradient(135deg, #1a1a2e 0%, #374151 100%)',
            boxShadow: '0 4px 15px rgba(26, 26, 46, 0.4)',
          }}>
            <Users className="w-8 h-8 text-white" />
          </Box>
          <Box sx={{ flex: 1 }}>
            <Typography variant="h5" sx={{ 
              fontWeight: 700, 
              background: 'linear-gradient(135deg, #0f172a 0%, #1f2937 100%)',
              backgroundClip: 'text',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}>
              Character Consistent Videos
            </Typography>
            <Typography variant="body2" sx={{ color: '#64748b' }}>
              Generate bulk videos with the same character
            </Typography>
          </Box>
          <Stack direction="row" spacing={1}>
            <Chip 
              icon={<Zap className="w-3 h-3" />} 
              label="20x Parallel" 
              size="small"
              sx={{ 
                bgcolor: 'rgba(26, 26, 46, 0.15)', 
                color: '#0f172a',
                border: '1px solid rgba(26, 26, 46, 0.3)',
                fontWeight: 600,
                fontSize: '0.7rem',
              }} 
            />
            <Chip 
              label="50 Max" 
              size="small"
              sx={{ 
                bgcolor: 'rgba(55, 65, 81, 0.15)', 
                color: '#1f2937',
                border: '1px solid rgba(55, 65, 81, 0.3)',
                fontWeight: 600,
                fontSize: '0.7rem',
              }} 
            />
          </Stack>
        </Box>

        <Grid container spacing={3}>
          <Grid size={{ xs: 12, md: 5 }}>
            <Paper sx={{ 
              p: 3, 
              background: 'white', 
              border: '1px solid #e5e7eb', 
              borderRadius: 3,
              boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
            }}>
              <Typography sx={{ 
                color: '#1f2937', 
                mb: 2, 
                display: 'flex', 
                alignItems: 'center', 
                gap: 1,
                fontWeight: 600,
                fontSize: '0.95rem',
              }}>
                <ImageIcon className="w-4 h-4 text-gray-700" />
                Character Reference
              </Typography>
              
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleImageUpload}
                accept="image/*"
                style={{ display: 'none' }}
                data-testid="input-character-image"
              />

              {characterImagePreview ? (
                <Box sx={{ position: 'relative' }}>
                  <Card sx={{ 
                    borderRadius: 2, 
                    overflow: 'hidden',
                    border: '2px solid rgba(26, 26, 46, 0.3)',
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    backgroundColor: 'rgba(26, 26, 46, 0.05)',
                    minHeight: 200,
                  }}>
                    <CardMedia
                      component="img"
                      image={characterImagePreview}
                      alt="Character"
                      sx={{ 
                        maxHeight: 320, 
                        maxWidth: '100%',
                        width: 'auto',
                        height: 'auto',
                        objectFit: 'contain',
                        display: 'block',
                      }}
                    />
                  </Card>
                  <IconButton
                    onClick={clearImage}
                    sx={{ 
                      position: 'absolute', 
                      top: 8, 
                      right: 8, 
                      bgcolor: 'rgba(239, 68, 68, 0.9)', 
                      color: 'white', 
                      '&:hover': { bgcolor: '#ef4444' },
                      width: 28,
                      height: 28,
                    }}
                    data-testid="button-clear-image"
                  >
                    <X className="w-4 h-4" />
                  </IconButton>
                </Box>
              ) : (
                <Box
                  onClick={() => fileInputRef.current?.click()}
                  sx={{
                    border: '2px dashed rgba(26, 26, 46, 0.4)',
                    borderRadius: 2,
                    p: 5,
                    textAlign: 'center',
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                    bgcolor: 'rgba(26, 26, 46, 0.03)',
                    '&:hover': { 
                      borderColor: '#1a1a2e', 
                      bgcolor: 'rgba(26, 26, 46, 0.08)',
                    }
                  }}
                  data-testid="button-upload-character"
                >
                  <Upload className="w-12 h-12 mx-auto mb-2 text-violet-400" />
                  <Typography sx={{ color: '#374151', fontWeight: 600, fontSize: '0.95rem' }}>
                    Upload Character Image
                  </Typography>
                  <Typography variant="caption" sx={{ color: '#9ca3af' }}>
                    PNG, JPG up to 10MB
                  </Typography>
                </Box>
              )}
            </Paper>
          </Grid>

          <Grid size={{ xs: 12, md: 7 }}>
            <Paper sx={{ 
              p: 3, 
              background: 'white', 
              border: '1px solid #e5e7eb', 
              borderRadius: 3,
              boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
            }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
                <Typography sx={{ 
                  color: '#1f2937', 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: 1,
                  fontWeight: 600,
                  fontSize: '0.95rem',
                }}>
                  <Sparkles className="w-4 h-4 text-gray-600" />
                  Scene Prompts
                </Typography>
                <Typography sx={{ color: '#9ca3af', fontSize: '0.8rem' }}>
                  {parsePrompts().length}/50
                </Typography>
              </Box>

              <TextField
                multiline
                rows={10}
                fullWidth
                placeholder={`Enter one prompt per line...\n\nExample prompts:\nA character walking through a mystical forest\nCharacter dancing in the rain at night\nCharacter sitting by a campfire under stars\nCharacter running through a field of flowers`}
                value={prompts}
                onChange={(e) => setPrompts(e.target.value)}
                disabled={isGenerating}
                sx={{
                  mb: 2,
                  '& .MuiOutlinedInput-root': {
                    color: '#1f2937',
                    bgcolor: '#f9fafb',
                    borderRadius: 2,
                    fontFamily: 'monospace',
                    fontSize: '0.85rem',
                    '& fieldset': { borderColor: '#e5e7eb' },
                    '&:hover fieldset': { borderColor: 'rgba(26, 26, 46, 0.5)' },
                    '&.Mui-focused fieldset': { borderColor: '#1a1a2e' },
                  },
                  '& .MuiOutlinedInput-input::placeholder': {
                    color: '#9ca3af',
                    opacity: 1,
                  },
                }}
                data-testid="textarea-prompts"
              />

              <Button
                variant="contained"
                onClick={handleGenerate}
                disabled={isGenerating || !characterImageData || parsePrompts().length === 0}
                fullWidth
                startIcon={isGenerating ? <CircularProgress size={18} sx={{ color: 'white' }} /> : <Zap className="w-4 h-4" />}
                sx={{ 
                  py: 1.5,
                  borderRadius: 2,
                  fontWeight: 600,
                  background: isGenerating 
                    ? '#9ca3af'
                    : 'linear-gradient(135deg, #1a1a2e 0%, #374151 100%)',
                  boxShadow: isGenerating ? 'none' : '0 4px 15px rgba(26, 26, 46, 0.4)',
                  '&:hover': { 
                    background: 'linear-gradient(135deg, #0f172a 0%, #1f2937 100%)',
                  },
                  '&:disabled': {
                    background: '#e5e7eb',
                    color: '#9ca3af',
                  }
                }}
                data-testid="button-generate"
              >
                {isGenerating 
                  ? `Processing ${activeCount}/${results.length}...` 
                  : `Generate ${parsePrompts().length} Videos`
                }
              </Button>
            </Paper>
          </Grid>
        </Grid>

        {results.length > 0 && (
          <Paper sx={{ 
            mt: 3, 
            p: { xs: 2, md: 3 }, 
            background: 'linear-gradient(135deg, #fafbfc 0%, #f1f5f9 100%)', 
            border: '1px solid #e2e8f0', 
            borderRadius: 3,
            boxShadow: '0 8px 32px rgba(0,0,0,0.08)',
          }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
              <Stack direction="row" spacing={1.5} alignItems="center">
                <Box sx={{ 
                  width: 40, 
                  height: 40, 
                  borderRadius: 2,
                  background: 'linear-gradient(135deg, #1a1a2e 0%, #374151 100%)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                  <Film className="w-5 h-5 text-white" />
                </Box>
                <Box>
                  <Typography sx={{ color: '#0f172a', fontWeight: 700, fontSize: '1.1rem' }}>
                    Video Queue
                  </Typography>
                  <Typography sx={{ color: '#64748b', fontSize: '0.75rem' }}>
                    {completedCount}/{results.length} completed
                  </Typography>
                </Box>
              </Stack>
              <Stack direction="row" spacing={1}>
                {activeCount > 0 && (
                  <Chip 
                    icon={<Loader2 className="w-3 h-3 animate-spin" />}
                    label={`${activeCount} Rendering`} 
                    size="small" 
                    sx={{ bgcolor: '#1a1a2e', color: 'white', height: 26, fontSize: '0.75rem', fontWeight: 600, '& .MuiChip-icon': { color: 'white' } }} 
                  />
                )}
                {completedCount > 0 && (
                  <Chip 
                    icon={<CheckCircle className="w-3 h-3" />}
                    label={`${completedCount} Ready`} 
                    size="small" 
                    sx={{ bgcolor: '#22c55e', color: 'white', height: 26, fontSize: '0.75rem', fontWeight: 600, '& .MuiChip-icon': { color: 'white' } }} 
                  />
                )}
              </Stack>
            </Box>

            {isGenerating && (
              <Box sx={{ mb: 3, p: 2, bgcolor: 'white', borderRadius: 2, border: '1px solid #e2e8f0' }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                  <Typography sx={{ fontSize: '0.8rem', color: '#64748b', fontWeight: 500 }}>Overall Progress</Typography>
                  <Typography sx={{ fontSize: '0.8rem', color: '#1a1a2e', fontWeight: 700 }}>{Math.round((completedCount + failedCount) / results.length * 100)}%</Typography>
                </Box>
                <LinearProgress 
                  variant="determinate" 
                  value={(completedCount + failedCount) / results.length * 100}
                  sx={{ 
                    height: 6, 
                    borderRadius: 3,
                    bgcolor: '#e2e8f0', 
                    '& .MuiLinearProgress-bar': { 
                      background: 'linear-gradient(90deg, #22c55e 0%, #16a34a 100%)',
                      borderRadius: 3,
                    } 
                  }} 
                />
              </Box>
            )}

            <Grid container spacing={2}>
              {results.map((result, index) => (
                <Grid size={{ xs: 12, sm: 6, md: 4, lg: 3 }} key={index}>
                  <Card sx={{ 
                    bgcolor: 'white', 
                    border: result.status === 'completed' ? '2px solid #22c55e' : result.status === 'failed' ? '2px solid #ef4444' : '1px solid #e2e8f0',
                    borderRadius: 2.5,
                    overflow: 'hidden',
                    boxShadow: result.status === 'completed' ? '0 4px 12px rgba(34, 197, 94, 0.2)' : 'none',
                    transition: 'all 0.25s ease',
                    '&:hover': {
                      transform: result.videoUrl ? 'translateY(-4px)' : 'none',
                      boxShadow: result.videoUrl ? '0 12px 24px rgba(0,0,0,0.15)' : 'none',
                    }
                  }}>
                    {result.videoUrl ? (
                      <Box sx={{ position: 'relative', aspectRatio: '16/9', bgcolor: '#0a0a0a' }}>
                        <video
                          src={result.videoUrl}
                          controls
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          data-testid={`video-player-${index}`}
                        />
                        <Box sx={{ position: 'absolute', top: 6, left: 6 }}>
                          <Box sx={{ 
                            width: 24, height: 24, borderRadius: '50%', 
                            bgcolor: '#22c55e', 
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            boxShadow: '0 2px 8px rgba(34, 197, 94, 0.4)'
                          }}>
                            <CheckCircle className="w-3.5 h-3.5 text-white" />
                          </Box>
                        </Box>
                        <Box sx={{ position: 'absolute', bottom: 6, left: 6, right: 6 }}>
                          <Box sx={{ 
                            bgcolor: 'rgba(0,0,0,0.7)', 
                            backdropFilter: 'blur(8px)',
                            borderRadius: 1.5, 
                            px: 1, py: 0.5,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                          }}>
                            <Typography sx={{ color: 'white', fontSize: '0.7rem', fontWeight: 600 }}>Scene {index + 1}</Typography>
                            <Button
                              size="small"
                              href={result.videoUrl}
                              target="_blank"
                              sx={{ 
                                minWidth: 'auto', p: 0.5, color: 'white',
                                '&:hover': { bgcolor: 'rgba(255,255,255,0.1)' }
                              }}
                            >
                              <Download className="w-3.5 h-3.5" />
                            </Button>
                          </Box>
                        </Box>
                      </Box>
                    ) : (
                      <Box sx={{ 
                        aspectRatio: '16/9',
                        display: 'flex', 
                        flexDirection: 'column',
                        alignItems: 'center', 
                        justifyContent: 'center', 
                        bgcolor: result.status === 'failed' ? '#fef2f2' : '#f8fafc',
                        background: result.status === 'failed' ? '#fef2f2' : 'linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%)',
                        position: 'relative',
                      }}>
                        <Box sx={{ position: 'absolute', top: 8, left: 8 }}>
                          <Typography sx={{ 
                            fontSize: '0.65rem', 
                            fontWeight: 700, 
                            color: '#94a3b8',
                            bgcolor: 'white',
                            px: 1,
                            py: 0.25,
                            borderRadius: 1,
                          }}>
                            #{index + 1}
                          </Typography>
                        </Box>
                        
                        {result.status === 'failed' ? (
                          <>
                            <Box sx={{ 
                              width: 44, height: 44, borderRadius: '50%', 
                              bgcolor: 'rgba(239, 68, 68, 0.1)', 
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              mb: 1
                            }}>
                              <AlertCircle className="w-5 h-5 text-red-500" />
                            </Box>
                            <Typography sx={{ color: '#ef4444', fontSize: '0.75rem', fontWeight: 600 }}>Failed</Typography>
                          </>
                        ) : result.status === 'pending' ? (
                          <>
                            <Box sx={{ 
                              width: 44, height: 44, borderRadius: '50%', 
                              bgcolor: '#e2e8f0', 
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              mb: 1
                            }}>
                              <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: '#94a3b8' }} />
                            </Box>
                            <Typography sx={{ color: '#94a3b8', fontSize: '0.75rem', fontWeight: 500 }}>In Queue</Typography>
                          </>
                        ) : (
                          <>
                            <Box sx={{ 
                              width: 52, height: 52, borderRadius: '50%', 
                              background: 'conic-gradient(#1a1a2e 0deg, #374151 120deg, #e2e8f0 120deg)',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              animation: 'spin 2s linear infinite',
                              '@keyframes spin': { '100%': { transform: 'rotate(360deg)' } },
                              mb: 1
                            }}>
                              <Box sx={{ 
                                width: 40, height: 40, borderRadius: '50%', 
                                bgcolor: '#f8fafc',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                              }}>
                                <Film className="w-4 h-4 text-gray-600" />
                              </Box>
                            </Box>
                            <Typography sx={{ color: '#475569', fontSize: '0.75rem', fontWeight: 600 }}>Rendering</Typography>
                            <Typography sx={{ color: '#94a3b8', fontSize: '0.65rem', mt: 0.25 }}>Please wait...</Typography>
                          </>
                        )}
                      </Box>
                    )}
                    
                    {/* Prompt section below video */}
                    <Box sx={{ p: 1.5, borderTop: '1px solid #f1f5f9' }}>
                      <Typography sx={{ 
                        color: '#374151', 
                        fontSize: '0.8rem',
                        fontWeight: 500,
                        lineHeight: 1.4, 
                        minHeight: 36,
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                        mb: 1,
                      }}>
                        Scene {index + 1}: {result.prompt}
                      </Typography>
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', pt: 1, borderTop: '1px solid #f3f4f6' }}>
                        <Chip 
                          label={`#${index + 1}`} 
                          size="small" 
                          sx={{ 
                            bgcolor: '#f3f4f6', 
                            color: '#6b7280',
                            fontWeight: 600,
                            fontSize: '0.7rem',
                            height: 22,
                          }} 
                        />
                        {result.videoUrl && (
                          <Button
                            size="small"
                            variant="contained"
                            href={result.videoUrl}
                            target="_blank"
                            startIcon={<Download className="w-3 h-3" />}
                            sx={{ 
                              bgcolor: '#1a1a2e',
                              fontSize: '0.7rem',
                              fontWeight: 600,
                              textTransform: 'none',
                              px: 1.5,
                              py: 0.5,
                              minHeight: 26,
                              borderRadius: 1.5,
                              '&:hover': { bgcolor: '#0f172a' }
                            }}
                          >
                            Download
                          </Button>
                        )}
                      </Box>
                    </Box>
                  </Card>
                </Grid>
              ))}
            </Grid>
          </Paper>
        )}
      </Box>
    </UserPanelLayout>
  );
}
