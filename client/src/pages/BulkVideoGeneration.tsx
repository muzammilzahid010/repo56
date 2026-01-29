import { useState } from "react";
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
import { Film, Sparkles, Download, Zap, CheckCircle, AlertCircle, Loader2, Play, ExternalLink, Eye, X, FileText, DownloadCloud, Plus, ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import Collapse from '@mui/material/Collapse';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import Backdrop from '@mui/material/Backdrop';

interface GeneratedResult {
  prompt: string;
  status: 'pending' | 'generating_image' | 'uploading_image' | 'generating_video' | 'polling' | 'completed' | 'failed';
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
  bulkVideoGenerationActive?: boolean;
}

interface JsonBlock {
  id: string;
  value: string;
  isExpanded: boolean;
}

// Generate unique block ID
const generateBlockId = () => `block-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

export default function BulkVideoGeneration() {
  const [prompts, setPrompts] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [results, setResults] = useState<GeneratedResult[]>([]);
  const [previewVideo, setPreviewVideo] = useState<{ url: string; prompt: string } | null>(null);
  const [isDownloadingAll, setIsDownloadingAll] = useState(false);
  const [inputMode, setInputMode] = useState<'text' | 'json'>('text');
  const [jsonBlocks, setJsonBlocks] = useState<JsonBlock[]>([{ id: generateBlockId(), value: '', isExpanded: true }]);
  const [clearPrevious, setClearPrevious] = useState(true);
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const handleDownload = async (videoUrl: string, prompt: string, index: number, silent = false) => {
    if (!silent) {
      toast({ title: "Downloading...", description: `Video #${index + 1} download starting` });
    }
    
    try {
      // Try direct CDN download first (faster)
      const directResponse = await fetch(videoUrl, { mode: 'cors' });
      if (directResponse.ok) {
        const blob = await directResponse.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `bulk_video_${index + 1}_${Date.now()}.mp4`;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        if (!silent) {
          toast({ title: "Download complete", description: `Video #${index + 1} saved!` });
        }
        return true;
      }
      throw new Error('Direct download failed');
    } catch (err) {
      // Fallback: use backend proxy
      try {
        const response = await fetch('/api/download-video', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ videoUrl, filename: `video_${index + 1}_${Date.now()}.mp4` }),
        });

        if (!response.ok) throw new Error('Proxy download failed');

        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `bulk_video_${index + 1}_${Date.now()}.mp4`;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        if (!silent) {
          toast({ title: "Download complete", description: `Video #${index + 1} saved!` });
        }
        return true;
      } catch {
        if (!silent) {
          toast({ title: "Download error", description: "Opening video in new tab instead.", variant: "destructive" });
        }
        window.open(videoUrl, '_blank');
        return false;
      }
    }
  };

  const handleDownloadAllVideos = async () => {
    const completedVideos = results.filter(r => r.videoUrl);
    if (completedVideos.length === 0) {
      toast({ title: "No videos", description: "No completed videos to download", variant: "destructive" });
      return;
    }

    setIsDownloadingAll(true);
    toast({ title: "Downloading all videos", description: `Starting parallel download of ${completedVideos.length} videos...` });

    const BATCH_SIZE = 5;
    let downloaded = 0;

    for (let i = 0; i < completedVideos.length; i += BATCH_SIZE) {
      const batch = completedVideos.slice(i, i + BATCH_SIZE);
      
      await Promise.all(batch.map(async (result) => {
        const originalIndex = results.findIndex(r => r === result);
        await handleDownload(result.videoUrl!, result.prompt, originalIndex, true);
        downloaded++;
      }));
      
      if (i + BATCH_SIZE < completedVideos.length) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }

    setIsDownloadingAll(false);
    toast({ title: "All downloads complete", description: `Downloaded ${downloaded} videos` });
  };

  const handleDownloadLinks = () => {
    const completedVideos = results.filter(r => r.videoUrl);
    if (completedVideos.length === 0) {
      toast({ title: "No videos", description: "No completed videos to export", variant: "destructive" });
      return;
    }

    const linksContent = completedVideos
      .map((result) => result.videoUrl)
      .join('\n');

    const blob = new Blob([linksContent], { type: 'text/plain' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `video_links_${Date.now()}.txt`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);

    toast({ title: "Links exported", description: `Exported ${completedVideos.length} video links to text file` });
  };

  const { data: maintenanceData } = useQuery<{ maintenance: ToolMaintenance }>({
    queryKey: ["/api/tool-maintenance"],
  });

  const { data: session, isLoading: sessionLoading } = useQuery<{
    authenticated: boolean;
    user?: { id: string; username: string; isAdmin: boolean; planType?: string };
  }>({
    queryKey: ["/api/session"],
  });

  if (maintenanceData?.maintenance && maintenanceData.maintenance.bulkVideoGenerationActive === false) {
    return (
      <UserPanelLayout>
        <Box sx={{ minHeight: '80vh', display: 'flex', alignItems: 'center', justifyContent: 'center', p: 4 }}>
          <Paper sx={{ p: 6, textAlign: 'center', maxWidth: 500, background: 'white', border: '1px solid rgba(26, 26, 46, 0.3)', boxShadow: '0 4px 20px rgba(0,0,0,0.1)' }}>
            <Film className="w-16 h-16 mx-auto text-gray-700 mb-4" />
            <Typography variant="h5" sx={{ color: '#7c3aed', fontWeight: 600, mb: 2 }}>Under Maintenance</Typography>
            <Typography sx={{ color: '#64748b' }}>Bulk Video Generation is currently under maintenance.</Typography>
          </Paper>
        </Box>
      </UserPanelLayout>
    );
  }

  if (!sessionLoading && session && !session.authenticated) {
    setLocation("/login");
    return null;
  }

  const userPlan = session?.user?.planType;
  const isAdmin = session?.user?.isAdmin;
  const hasAccess = isAdmin || userPlan === 'empire' || userPlan === 'enterprise' || userPlan === 'scale';
  
  // Video limits based on plan: Empire/Enterprise = 100, Scale = 50
  const maxVideos = (userPlan === 'empire' || userPlan === 'enterprise' || isAdmin) ? 100 : 50;

  if (!sessionLoading && session?.authenticated && !hasAccess) {
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
              <Film className="w-8 h-8 text-white" />
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
              Bulk Video Generation is an exclusive feature for Empire plan users. Upgrade to unlock bulk video generation from prompts.
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

  const parsePrompts = (): string[] => {
    if (inputMode === 'json') {
      return jsonBlocks
        .map(b => b.value.trim())
        .filter(p => p.length >= 3);
    }
    return prompts
      .split('\n')
      .map(p => p.trim())
      .filter(p => p.length >= 3);
  };

  const handleBlockChange = (id: string, value: string) => {
    setJsonBlocks(prev => {
      const updated = prev.map(block => 
        block.id === id ? { ...block, value } : block
      );
      
      const currentBlockIndex = updated.findIndex(b => b.id === id);
      const currentBlock = updated[currentBlockIndex];
      
      if (currentBlock && currentBlock.value.trim().length > 0) {
        const nextBlockIndex = currentBlockIndex + 1;
        if (nextBlockIndex < updated.length && !updated[nextBlockIndex].isExpanded) {
          updated[nextBlockIndex] = { ...updated[nextBlockIndex], isExpanded: true };
        }
        
        if (nextBlockIndex >= updated.length && updated.length < maxVideos) {
          updated.push({ id: generateBlockId(), value: '', isExpanded: true });
        }
      }
      
      return updated;
    });
  };

  const handleBlockToggle = (id: string) => {
    setJsonBlocks(prev => prev.map(block => 
      block.id === id ? { ...block, isExpanded: !block.isExpanded } : block
    ));
  };

  const handleRemoveBlock = (id: string) => {
    if (jsonBlocks.length <= 1) return;
    setJsonBlocks(prev => prev.filter(b => b.id !== id));
  };

  const handleAddBlock = () => {
    if (jsonBlocks.length >= maxVideos) {
      toast({ title: "Limit reached", description: `Maximum ${maxVideos} prompts for your plan`, variant: "destructive" });
      return;
    }
    setJsonBlocks(prev => [...prev, { id: generateBlockId(), value: '', isExpanded: true }]);
  };

  const getFilledBlocksCount = () => jsonBlocks.filter(b => b.value.trim().length >= 3).length;

  const handleGenerate = async () => {
    const promptList = parsePrompts();
    
    if (promptList.length === 0) {
      toast({ title: "No prompts", description: "Please enter at least one prompt", variant: "destructive" });
      return;
    }

    if (promptList.length > maxVideos) {
      toast({ title: "Too many prompts", description: `Maximum ${maxVideos} prompts per batch for your plan`, variant: "destructive" });
      return;
    }

    setIsGenerating(true);
    
    // Clear previous results if checkbox is enabled, otherwise append
    if (clearPrevious) {
      setResults(promptList.map(prompt => ({ prompt, status: 'pending' })));
    } else {
      setResults(prev => [...promptList.map(prompt => ({ prompt, status: 'pending' as const })), ...prev]);
    }

    try {
      const response = await fetch("/api/bulk-video-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          prompts: promptList,
          aspectRatio: "IMAGE_ASPECT_RATIO_LANDSCAPE",
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
              
              if (eventType === 'progress') {
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
                throw new Error(data.error || 'Stream error');
              }
            } catch (parseError) {
              console.error('SSE parse error:', parseError);
            }
          }
        }
      }

    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      setIsGenerating(false);
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
      <Box sx={{ position: 'relative', zIndex: 1, p: { xs: 2, md: 4 }, maxWidth: 1200, mx: 'auto' }}>
        <Box sx={{ 
          display: 'flex', 
          flexDirection: { xs: 'column', sm: 'row' },
          alignItems: { xs: 'flex-start', sm: 'center' }, 
          gap: { xs: 2, sm: 3 }, 
          mb: { xs: 2, md: 4 },
          p: { xs: 2, md: 3 },
          borderRadius: 3,
          background: 'linear-gradient(135deg, rgba(26, 26, 46, 0.1) 0%, rgba(55, 65, 81, 0.1) 100%)',
          border: '1px solid rgba(26, 26, 46, 0.2)',
        }}>
          <Stack direction="row" spacing={2} alignItems="center" sx={{ width: { xs: '100%', sm: 'auto' } }}>
            <Box sx={{ 
              p: { xs: 1.5, md: 2 }, 
              borderRadius: 2, 
              background: 'linear-gradient(135deg, #1a1a2e 0%, #374151 100%)',
              boxShadow: '0 4px 15px rgba(26, 26, 46, 0.4)',
            }}>
              <Film className="w-6 h-6 md:w-8 md:h-8 text-white" />
            </Box>
            <Box sx={{ flex: 1 }}>
              <Typography sx={{ 
                fontWeight: 700, 
                fontSize: { xs: '1.1rem', md: '1.25rem' },
                background: 'linear-gradient(135deg, #0f172a 0%, #1f2937 100%)',
                backgroundClip: 'text',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
              }}>
                Bulk Video Generation
              </Typography>
              <Typography sx={{ color: '#64748b', fontSize: { xs: '0.75rem', md: '0.875rem' }, display: { xs: 'none', sm: 'block' } }}>
                Generate videos from multiple prompts at once
              </Typography>
            </Box>
          </Stack>
          <Stack direction="row" spacing={1} sx={{ display: { xs: 'none', md: 'flex' } }}>
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

        <Paper sx={{ 
          p: { xs: 2, md: 3 }, 
          background: 'white', 
          border: '1px solid #e5e7eb', 
          borderRadius: { xs: 2, md: 3 },
          boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
          mb: { xs: 2, md: 3 },
        }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2, flexWrap: 'wrap', gap: 2 }}>
            <Typography sx={{ 
              color: '#1f2937', 
              display: 'flex', 
              alignItems: 'center', 
              gap: 1,
              fontWeight: 600,
              fontSize: '0.95rem',
            }}>
              <Sparkles className="w-4 h-4 text-gray-600" />
              Video Prompts
            </Typography>
            
            <Stack direction="row" spacing={2} alignItems="center">
              <ToggleButtonGroup
                value={inputMode}
                exclusive
                onChange={(_, newMode) => newMode && setInputMode(newMode)}
                disabled={isGenerating}
                size="small"
                sx={{
                  '& .MuiToggleButton-root': {
                    textTransform: 'none',
                    fontWeight: 600,
                    fontSize: '0.75rem',
                    px: 2,
                    py: 0.5,
                    border: '1px solid rgba(26, 26, 46, 0.3)',
                    color: '#64748b',
                    '&.Mui-selected': {
                      background: 'linear-gradient(135deg, #1a1a2e 0%, #374151 100%)',
                      color: 'white',
                      border: '1px solid transparent',
                      '&:hover': {
                        background: 'linear-gradient(135deg, #0f172a 0%, #1f2937 100%)',
                      }
                    },
                    '&:hover': {
                      bgcolor: 'rgba(26, 26, 46, 0.08)',
                    }
                  }
                }}
              >
                <ToggleButton value="text" data-testid="toggle-text-mode">
                  <FileText className="w-3 h-3 mr-1" /> Text Mode
                </ToggleButton>
                <ToggleButton value="json" data-testid="toggle-json-mode">
                  <Plus className="w-3 h-3 mr-1" /> JSON Blocks
                </ToggleButton>
              </ToggleButtonGroup>
              
              <Typography sx={{ color: '#9ca3af', fontSize: '0.8rem' }}>
                {inputMode === 'json' ? getFilledBlocksCount() : parsePrompts().length}/{maxVideos}
              </Typography>
            </Stack>
          </Box>

          {inputMode === 'text' ? (
            <TextField
              multiline
              rows={12}
              fullWidth
              placeholder={`Enter one prompt per line (max ${maxVideos} videos)...\n\nExample prompts:\nA magical sunset over mountains with birds flying\nA futuristic city with flying cars at night\nAn underwater scene with colorful coral reef\nA peaceful garden with butterflies and flowers\nA dramatic storm over the ocean with lightning`}
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
          ) : (
            <Box sx={{ mb: 2 }}>
              <Paper 
                elevation={0} 
                sx={{ 
                  border: '1px solid rgba(26, 26, 46, 0.15)', 
                  borderRadius: 2,
                  overflow: 'hidden',
                }}
              >
                {jsonBlocks.map((block, index) => {
                  const hasContent = block.value.trim().length >= 3;
                  return (
                    <Box 
                      key={block.id}
                      sx={{ 
                        borderBottom: index < jsonBlocks.length - 1 ? '1px solid rgba(26, 26, 46, 0.1)' : 'none',
                      }}
                    >
                      <Box
                        onClick={() => handleBlockToggle(block.id)}
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          px: { xs: 1.5, md: 2 },
                          py: { xs: 1, md: 1.25 },
                          cursor: 'pointer',
                          bgcolor: hasContent ? 'rgba(34, 197, 94, 0.08)' : 'transparent',
                          '&:hover': {
                            bgcolor: hasContent ? 'rgba(34, 197, 94, 0.12)' : 'rgba(26, 26, 46, 0.04)',
                          }
                        }}
                      >
                        <Stack direction="row" spacing={1} alignItems="center" sx={{ flex: 1, minWidth: 0 }}>
                          {block.isExpanded ? (
                            <ChevronDown className="w-4 h-4 text-gray-500 flex-shrink-0" />
                          ) : (
                            <ChevronRight className="w-4 h-4 text-gray-500 flex-shrink-0" />
                          )}
                          <Box
                            sx={{
                              width: { xs: 20, md: 22 },
                              height: { xs: 20, md: 22 },
                              borderRadius: '50%',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              flexShrink: 0,
                              background: hasContent 
                                ? 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)'
                                : '#e5e7eb',
                              color: hasContent ? 'white' : '#64748b',
                              fontSize: { xs: '0.65rem', md: '0.7rem' },
                              fontWeight: 700,
                            }}
                          >
                            {index + 1}
                          </Box>
                          <Typography 
                            noWrap
                            sx={{ 
                              color: hasContent ? '#16a34a' : '#94a3b8', 
                              fontSize: { xs: '0.8rem', md: '0.85rem' },
                              fontWeight: 500,
                              flex: 1,
                              minWidth: 0,
                            }}
                          >
                            {hasContent 
                              ? block.value.substring(0, 40) + (block.value.length > 40 ? '...' : '')
                              : `Scene ${index + 1}`
                            }
                          </Typography>
                          {hasContent && (
                            <CheckCircle className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                          )}
                        </Stack>
                        
                        {jsonBlocks.length > 1 && (
                          <IconButton
                            size="small"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRemoveBlock(block.id);
                            }}
                            disabled={isGenerating}
                            sx={{ 
                              ml: 0.5,
                              color: '#cbd5e1',
                              p: { xs: 0.5, md: 1 },
                              '&:hover': { color: '#ef4444', bgcolor: 'rgba(239, 68, 68, 0.08)' }
                            }}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </IconButton>
                        )}
                      </Box>
                      
                      <Collapse in={block.isExpanded}>
                        <Box sx={{ px: { xs: 1.5, md: 2 }, pb: { xs: 1.5, md: 2 }, pt: 0.5 }}>
                          <TextField
                            fullWidth
                            multiline
                            minRows={2}
                            maxRows={6}
                            placeholder="Describe your video scene..."
                            value={block.value}
                            onChange={(e) => handleBlockChange(block.id, e.target.value)}
                            disabled={isGenerating}
                            onClick={(e) => e.stopPropagation()}
                            sx={{
                              '& .MuiOutlinedInput-root': {
                                color: '#1f2937',
                                bgcolor: '#f8fafc',
                                borderRadius: 1.5,
                                fontSize: { xs: '0.85rem', md: '0.9rem' },
                                lineHeight: 1.5,
                                '& fieldset': { borderColor: '#e2e8f0' },
                                '&:hover fieldset': { borderColor: '#94a3b8' },
                                '&.Mui-focused fieldset': { borderColor: '#7c3aed', borderWidth: 2 },
                              },
                            }}
                            data-testid={`input-block-${index + 1}`}
                          />
                        </Box>
                      </Collapse>
                    </Box>
                  );
                })}
              </Paper>
              
              {jsonBlocks.length < maxVideos && (
                <Button
                  variant="text"
                  onClick={handleAddBlock}
                  disabled={isGenerating}
                  startIcon={<Plus className="w-4 h-4" />}
                  sx={{
                    mt: 1.5,
                    color: '#64748b',
                    fontWeight: 500,
                    textTransform: 'none',
                    fontSize: '0.85rem',
                    '&:hover': {
                      color: '#7c3aed',
                      bgcolor: 'rgba(124, 58, 237, 0.04)',
                    }
                  }}
                  data-testid="button-add-block"
                >
                  Add Scene ({jsonBlocks.length}/{maxVideos})
                </Button>
              )}
            </Box>
          )}

          <FormControlLabel
            control={
              <Checkbox 
                checked={clearPrevious} 
                onChange={(e) => setClearPrevious(e.target.checked)}
                sx={{ 
                  color: '#1a1a2e',
                  '&.Mui-checked': { color: '#1a1a2e' }
                }}
                data-testid="checkbox-clear-previous"
              />
            }
            label={
              <Stack direction="row" spacing={1} alignItems="center">
                <Trash2 className="w-4 h-4" style={{ color: '#1a1a2e' }} />
                <Typography sx={{ color: '#1a1a2e', fontSize: '0.9rem', fontWeight: 500 }}>
                  Clear previous generation before starting new
                </Typography>
              </Stack>
            }
            sx={{ mb: 2 }}
          />

          <Button
            variant="contained"
            onClick={handleGenerate}
            disabled={isGenerating || parsePrompts().length === 0 || parsePrompts().length > maxVideos}
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

        {results.length > 0 && (
          <Paper sx={{ 
            p: 3, 
            background: 'white', 
            border: '1px solid #e5e7eb', 
            borderRadius: 3,
            boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
          }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2, flexWrap: 'wrap', gap: 1 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <Typography sx={{ color: '#1f2937', fontWeight: 600, fontSize: '0.95rem' }}>
                  Progress
                </Typography>
                <Stack direction="row" spacing={1}>
                  {activeCount > 0 && (
                    <Chip label={`${activeCount} Active`} size="small" sx={{ bgcolor: 'rgba(26, 26, 46, 0.15)', color: '#0f172a', height: 22, fontSize: '0.7rem' }} />
                  )}
                  {completedCount > 0 && (
                    <Chip label={`${completedCount} Done`} size="small" sx={{ bgcolor: 'rgba(34, 197, 94, 0.15)', color: '#16a34a', height: 22, fontSize: '0.7rem' }} />
                  )}
                  {failedCount > 0 && (
                    <Chip label={`${failedCount} Failed`} size="small" sx={{ bgcolor: 'rgba(239, 68, 68, 0.15)', color: '#dc2626', height: 22, fontSize: '0.7rem' }} />
                  )}
                </Stack>
              </Box>
              
              {completedCount > 0 && (
                <Stack direction="row" spacing={1}>
                  <Button
                    variant="contained"
                    size="small"
                    startIcon={isDownloadingAll ? <Loader2 className="w-4 h-4 animate-spin" /> : <DownloadCloud className="w-4 h-4" />}
                    onClick={handleDownloadAllVideos}
                    disabled={isDownloadingAll || isGenerating}
                    sx={{ 
                      py: 0.75,
                      px: 2,
                      borderRadius: 2,
                      fontWeight: 600,
                      fontSize: '0.75rem',
                      textTransform: 'none',
                      background: 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)',
                      boxShadow: '0 4px 12px rgba(34, 197, 94, 0.3)',
                      '&:hover': { 
                        background: 'linear-gradient(135deg, #16a34a 0%, #15803d 100%)',
                      },
                      '&:disabled': {
                        background: '#e5e7eb',
                        color: '#9ca3af',
                      }
                    }}
                    data-testid="button-download-all"
                  >
                    {isDownloadingAll ? 'Downloading...' : 'Download All'}
                  </Button>
                  <Button
                    variant="outlined"
                    size="small"
                    startIcon={<FileText className="w-4 h-4" />}
                    onClick={handleDownloadLinks}
                    disabled={isGenerating}
                    sx={{ 
                      py: 0.75,
                      px: 2,
                      borderRadius: 2,
                      fontWeight: 600,
                      fontSize: '0.75rem',
                      textTransform: 'none',
                      borderColor: 'rgba(26, 26, 46, 0.5)',
                      color: '#0f172a',
                      '&:hover': { 
                        borderColor: '#1a1a2e',
                        bgcolor: 'rgba(26, 26, 46, 0.08)',
                      },
                    }}
                    data-testid="button-download-links"
                  >
                    Download Links
                  </Button>
                </Stack>
              )}
            </Box>

            {isGenerating && (
              <LinearProgress 
                variant="determinate" 
                value={(completedCount + failedCount) / results.length * 100}
                sx={{ 
                  mb: 2,
                  height: 6, 
                  borderRadius: 3,
                  bgcolor: 'rgba(26, 26, 46, 0.1)', 
                  '& .MuiLinearProgress-bar': { 
                    background: 'linear-gradient(90deg, #1a1a2e 0%, #374151 100%)',
                    borderRadius: 3,
                  } 
                }} 
              />
            )}

            <Grid container spacing={2}>
              {results.map((result, index) => (
                <Grid size={{ xs: 12, sm: 6, md: 4, lg: 3 }} key={index}>
                  <Card sx={{ 
                    bgcolor: 'white',
                    border: result.status === 'completed' 
                      ? '2px solid rgba(34, 197, 94, 0.4)'
                      : result.status === 'failed'
                      ? '2px solid rgba(239, 68, 68, 0.4)'
                      : '1px solid rgba(26, 26, 46, 0.2)',
                    borderRadius: 3,
                    overflow: 'hidden',
                    boxShadow: result.status === 'completed' 
                      ? '0 8px 30px rgba(34, 197, 94, 0.15)'
                      : '0 4px 20px rgba(0, 0, 0, 0.08)',
                    transition: 'all 0.3s ease',
                    '&:hover': {
                      transform: result.videoUrl ? 'translateY(-4px)' : 'none',
                      boxShadow: result.videoUrl 
                        ? '0 12px 40px rgba(26, 26, 46, 0.25)'
                        : '0 4px 20px rgba(0, 0, 0, 0.08)',
                    },
                  }}>
                    <Box sx={{ position: 'relative', height: 160, bgcolor: '#0f0f0f' }}>
                      {result.videoUrl ? (
                        <>
                          <video
                            src={result.videoUrl}
                            muted
                            loop
                            playsInline
                            onMouseOver={(e) => (e.target as HTMLVideoElement).play()}
                            onMouseOut={(e) => { (e.target as HTMLVideoElement).pause(); (e.target as HTMLVideoElement).currentTime = 0; }}
                            style={{ 
                              width: '100%', 
                              height: '100%', 
                              objectFit: 'cover',
                            }}
                            data-testid={`video-player-${index}`}
                          />
                          <Box sx={{ 
                            position: 'absolute', 
                            inset: 0, 
                            background: 'linear-gradient(to top, rgba(0,0,0,0.7) 0%, transparent 50%)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            opacity: 0,
                            transition: 'opacity 0.3s ease',
                            '&:hover': { opacity: 1 },
                          }}>
                            <IconButton
                              onClick={() => setPreviewVideo({ url: result.videoUrl!, prompt: result.prompt })}
                              sx={{ 
                                bgcolor: 'rgba(26, 26, 46, 0.9)',
                                color: 'white',
                                p: 1.5,
                                '&:hover': { bgcolor: '#0f172a', transform: 'scale(1.1)' },
                                transition: 'all 0.2s ease',
                              }}
                              data-testid={`button-play-${index}`}
                            >
                              <Play className="w-6 h-6" fill="white" />
                            </IconButton>
                          </Box>
                          <Chip 
                            icon={<CheckCircle className="w-3 h-3" />}
                            label="Ready" 
                            size="small"
                            sx={{ 
                              position: 'absolute',
                              top: 8,
                              right: 8,
                              bgcolor: 'rgba(34, 197, 94, 0.9)',
                              color: 'white',
                              fontWeight: 600,
                              fontSize: '0.65rem',
                              height: 22,
                              '& .MuiChip-icon': { color: 'white' },
                            }}
                          />
                        </>
                      ) : result.status !== 'pending' && result.status !== 'failed' ? (
                        <Box sx={{ 
                          height: '100%', 
                          display: 'flex', 
                          alignItems: 'center', 
                          justifyContent: 'center', 
                          background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)',
                          flexDirection: 'column',
                          gap: 2,
                          position: 'relative',
                          overflow: 'hidden',
                        }}>
                          <Box sx={{
                            position: 'absolute',
                            inset: 0,
                            background: 'radial-gradient(circle at 50% 50%, rgba(26, 26, 46, 0.15) 0%, transparent 70%)',
                          }} />
                          <Box sx={{ 
                            position: 'relative',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}>
                            <Box sx={{
                              width: 64,
                              height: 64,
                              borderRadius: '50%',
                              border: '3px solid rgba(26, 26, 46, 0.3)',
                              borderTopColor: '#1a1a2e',
                              animation: 'spin 1s linear infinite',
                              '@keyframes spin': {
                                '0%': { transform: 'rotate(0deg)' },
                                '100%': { transform: 'rotate(360deg)' },
                              },
                            }} />
                            <Film className="w-6 h-6 text-violet-400" style={{ position: 'absolute' }} />
                          </Box>
                          <Typography sx={{ 
                            color: 'white', 
                            fontSize: '0.8rem',
                            fontWeight: 600,
                            textAlign: 'center',
                          }}>
                            Generating Video
                          </Typography>
                          <Typography sx={{ 
                            color: 'rgba(26, 26, 46, 0.8)', 
                            fontSize: '0.65rem',
                            fontWeight: 500,
                          }}>
                            Please wait...
                          </Typography>
                        </Box>
                      ) : (
                        <Box sx={{ 
                          height: '100%', 
                          display: 'flex', 
                          alignItems: 'center', 
                          justifyContent: 'center', 
                          background: result.status === 'failed' 
                            ? 'linear-gradient(135deg, #fef2f2 0%, #fee2e2 100%)'
                            : 'linear-gradient(135deg, #f3f4f6 0%, #e5e7eb 100%)',
                          flexDirection: 'column',
                          gap: 1,
                        }}>
                          {result.status === 'failed' ? (
                            <>
                              <AlertCircle className="w-10 h-10 text-red-400" />
                              <Typography sx={{ color: '#dc2626', fontSize: '0.75rem', fontWeight: 500 }}>
                                Generation Failed
                              </Typography>
                              {result.error && (
                                <Typography sx={{ color: '#9ca3af', fontSize: '0.65rem', px: 2, textAlign: 'center' }}>
                                  {result.error.slice(0, 50)}
                                </Typography>
                              )}
                            </>
                          ) : (
                            <>
                              <Box sx={{ 
                                p: 2, 
                                borderRadius: '50%', 
                                background: 'linear-gradient(135deg, rgba(26, 26, 46, 0.2) 0%, rgba(55, 65, 81, 0.2) 100%)',
                              }}>
                                <Loader2 className="w-8 h-8 text-gray-700 animate-spin" />
                              </Box>
                              <Typography sx={{ 
                                color: '#6b7280', 
                                fontSize: '0.75rem',
                                fontWeight: 500,
                              }}>
                                Waiting to start...
                              </Typography>
                            </>
                          )}
                        </Box>
                      )}
                    </Box>

                    <Box sx={{ p: 2 }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
                        <Box sx={{ 
                          width: 24, 
                          height: 24, 
                          borderRadius: '50%', 
                          background: result.status === 'completed'
                            ? 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)'
                            : result.status === 'failed'
                            ? 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)'
                            : 'linear-gradient(135deg, #1a1a2e 0%, #374151 100%)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}>
                          <Typography sx={{ color: 'white', fontSize: '0.65rem', fontWeight: 700 }}>
                            {index + 1}
                          </Typography>
                        </Box>
                        <Typography sx={{ 
                          color: '#1f2937', 
                          fontSize: '0.8rem',
                          fontWeight: 500,
                          lineHeight: 1.3, 
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          flex: 1,
                        }}>
                          {result.prompt}
                        </Typography>
                      </Box>

                      {result.videoUrl && (
                        <Stack direction="row" spacing={1}>
                          <Button
                            variant="contained"
                            size="small"
                            startIcon={<Eye className="w-3.5 h-3.5" />}
                            onClick={() => setPreviewVideo({ url: result.videoUrl!, prompt: result.prompt })}
                            sx={{ 
                              flex: 1,
                              py: 0.75,
                              borderRadius: 2,
                              fontWeight: 600,
                              fontSize: '0.75rem',
                              textTransform: 'none',
                              background: 'linear-gradient(135deg, #1a1a2e 0%, #374151 100%)',
                              boxShadow: '0 4px 12px rgba(26, 26, 46, 0.3)',
                              '&:hover': { 
                                background: 'linear-gradient(135deg, #0f172a 0%, #1f2937 100%)',
                              },
                            }}
                            data-testid={`button-view-${index}`}
                          >
                            View
                          </Button>
                          <Button
                            variant="outlined"
                            size="small"
                            startIcon={<Download className="w-3.5 h-3.5" />}
                            onClick={() => handleDownload(result.videoUrl!, result.prompt, index)}
                            sx={{ 
                              flex: 1,
                              py: 0.75,
                              borderRadius: 2,
                              fontWeight: 600,
                              fontSize: '0.75rem',
                              textTransform: 'none',
                              borderColor: 'rgba(26, 26, 46, 0.5)',
                              color: '#0f172a',
                              '&:hover': { 
                                borderColor: '#1a1a2e',
                                bgcolor: 'rgba(26, 26, 46, 0.08)',
                              },
                            }}
                            data-testid={`button-download-${index}`}
                          >
                            Download
                          </Button>
                        </Stack>
                      )}

                      {result.status === 'failed' && (
                        <Box sx={{ 
                          p: 1.5, 
                          bgcolor: 'rgba(239, 68, 68, 0.08)', 
                          borderRadius: 2,
                          border: '1px solid rgba(239, 68, 68, 0.2)',
                        }}>
                          <Typography sx={{ color: '#dc2626', fontSize: '0.7rem', display: 'flex', alignItems: 'center', gap: 0.5 }}>
                            <AlertCircle className="w-3 h-3" />
                            {result.error || 'Generation failed'}
                          </Typography>
                        </Box>
                      )}

                      {!result.videoUrl && result.status !== 'failed' && (
                        <LinearProgress 
                          variant={result.status === 'pending' ? 'determinate' : 'indeterminate'}
                          value={result.status === 'pending' ? 0 : undefined}
                          sx={{ 
                            height: 4, 
                            borderRadius: 2,
                            bgcolor: 'rgba(26, 26, 46, 0.1)', 
                            '& .MuiLinearProgress-bar': { 
                              background: 'linear-gradient(90deg, #1a1a2e 0%, #374151 100%)',
                              borderRadius: 2,
                            } 
                          }} 
                        />
                      )}
                    </Box>
                  </Card>
                </Grid>
              ))}
            </Grid>
          </Paper>
        )}

        <Dialog
          open={!!previewVideo}
          onClose={() => setPreviewVideo(null)}
          maxWidth="lg"
          fullWidth
          PaperProps={{
            sx: {
              bgcolor: 'transparent',
              boxShadow: 'none',
              overflow: 'visible',
            }
          }}
          BackdropProps={{
            sx: {
              bgcolor: 'rgba(0, 0, 0, 0.9)',
              backdropFilter: 'blur(8px)',
            }
          }}
        >
          <DialogContent sx={{ p: 0, position: 'relative' }}>
            <IconButton
              onClick={() => setPreviewVideo(null)}
              sx={{
                position: 'absolute',
                top: -48,
                right: 0,
                color: 'white',
                bgcolor: 'rgba(255, 255, 255, 0.1)',
                '&:hover': { bgcolor: 'rgba(255, 255, 255, 0.2)' },
              }}
              data-testid="button-close-preview"
            >
              <X className="w-6 h-6" />
            </IconButton>

            {previewVideo && (
              <Box sx={{ position: 'relative', borderRadius: 3, overflow: 'hidden' }}>
                <video
                  src={previewVideo.url}
                  controls
                  autoPlay
                  style={{ 
                    width: '100%', 
                    maxHeight: '70vh',
                    objectFit: 'contain',
                    borderRadius: 12,
                  }}
                  data-testid="video-preview-player"
                />
                <Box sx={{ 
                  mt: 2, 
                  p: 2, 
                  bgcolor: 'rgba(255, 255, 255, 0.05)',
                  borderRadius: 2,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 2,
                }}>
                  <Typography sx={{ color: 'white', fontSize: '0.9rem', flex: 1 }}>
                    {previewVideo.prompt}
                  </Typography>
                  <Stack direction="row" spacing={1}>
                    <Button
                      variant="contained"
                      size="small"
                      startIcon={<Download className="w-4 h-4" />}
                      onClick={() => handleDownload(previewVideo.url, previewVideo.prompt, 0)}
                      sx={{ 
                        py: 1,
                        px: 2,
                        borderRadius: 2,
                        fontWeight: 600,
                        textTransform: 'none',
                        background: 'linear-gradient(135deg, #1a1a2e 0%, #374151 100%)',
                        '&:hover': { 
                          background: 'linear-gradient(135deg, #0f172a 0%, #1f2937 100%)',
                        },
                      }}
                      data-testid="button-download-preview"
                    >
                      Download
                    </Button>
                    <Button
                      variant="outlined"
                      size="small"
                      startIcon={<ExternalLink className="w-4 h-4" />}
                      onClick={() => window.open(previewVideo.url, '_blank')}
                      sx={{ 
                        py: 1,
                        px: 2,
                        borderRadius: 2,
                        fontWeight: 600,
                        textTransform: 'none',
                        borderColor: 'rgba(255, 255, 255, 0.3)',
                        color: 'white',
                        '&:hover': { 
                          borderColor: 'white',
                          bgcolor: 'rgba(255, 255, 255, 0.1)',
                        },
                      }}
                      data-testid="button-open-new-tab"
                    >
                      Open
                    </Button>
                  </Stack>
                </Box>
              </Box>
            )}
          </DialogContent>
        </Dialog>
      </Box>
    </UserPanelLayout>
  );
}
