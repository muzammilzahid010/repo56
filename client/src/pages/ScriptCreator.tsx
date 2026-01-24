import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import UserPanelLayout from "@/layouts/UserPanelLayout";
import AnimatedDotsBackground from "@/components/AnimatedDotsBackground";

import { alpha } from '@mui/material/styles';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import CircularProgress from '@mui/material/CircularProgress';
import Chip from '@mui/material/Chip';
import Slider from '@mui/material/Slider';
import { FileText, Sparkles, Copy, Wand2 } from "lucide-react";

interface ToolMaintenance {
  veoGeneratorActive: boolean;
  bulkGeneratorActive: boolean;
  textToImageActive: boolean;
  imageToVideoActive: boolean;
  scriptCreatorActive: boolean;
  characterConsistencyActive: boolean;
}

export default function ScriptCreator() {
  const [storyAbout, setStoryAbout] = useState("");
  const [numberOfPrompts, setNumberOfPrompts] = useState(10);
  const [finalStep, setFinalStep] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedScript, setGeneratedScript] = useState<string | null>(null);
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  // Check tool maintenance status
  const { data: maintenanceData } = useQuery<{ maintenance: ToolMaintenance }>({
    queryKey: ["/api/tool-maintenance"],
  });

  const { data: session, isLoading: sessionLoading } = useQuery<{
    authenticated: boolean;
    user?: { id: string; username: string; isAdmin: boolean };
  }>({
    queryKey: ["/api/session"],
  });

  // Show maintenance message if tool is disabled
  if (maintenanceData?.maintenance && !maintenanceData.maintenance.scriptCreatorActive) {
    return (
      <UserPanelLayout>
        <Box sx={{ 
          minHeight: '80vh', 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center',
          p: 4 
        }}>
          <Paper sx={{ 
            p: 6, 
            textAlign: 'center', 
            maxWidth: 500,
            background: 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)',
            border: '1px solid rgba(251, 146, 60, 0.3)'
          }}>
            <Box sx={{ fontSize: 64, mb: 2 }}>
              <FileText className="w-16 h-16 mx-auto text-orange-400" />
            </Box>
            <Typography variant="h5" sx={{ color: '#f97316', fontWeight: 600, mb: 2 }}>
              Under Maintenance
            </Typography>
            <Typography sx={{ color: '#94a3b8' }}>
              Script Creator is currently under maintenance. Please check back later.
            </Typography>
          </Paper>
        </Box>
      </UserPanelLayout>
    );
  }

  useEffect(() => {
    if (!sessionLoading && session && !session.authenticated) {
      toast({
        title: "Authentication required",
        description: "Please log in to use the script creator.",
        variant: "destructive",
      });
      setLocation("/login");
    }
  }, [session, sessionLoading, setLocation, toast]);

  const handleGenerate = async () => {
    if (!storyAbout.trim()) {
      toast({ title: "Story required", description: "Please describe what your story is about", variant: "destructive" });
      return;
    }

    if (!finalStep.trim()) {
      toast({ title: "Final step required", description: "Please describe what the final step should be", variant: "destructive" });
      return;
    }

    setIsGenerating(true);
    setGeneratedScript(null);

    try {
      const response = await fetch('/api/generate-script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ storyAbout, numberOfPrompts, finalStep }),
      });

      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Failed to generate script');

      setGeneratedScript(result.script);
      toast({ title: "Script generated!", description: "Your storyboard has been created successfully." });
    } catch (error) {
      toast({ title: "Generation failed", description: error instanceof Error ? error.message : "An error occurred", variant: "destructive" });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCopyScript = () => {
    if (generatedScript) {
      navigator.clipboard.writeText(generatedScript);
      toast({ title: "Copied!", description: "Script copied to clipboard" });
    }
  };

  if (sessionLoading) {
    return (
      <UserPanelLayout>
        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 400 }}>
          <CircularProgress />
        </Box>
      </UserPanelLayout>
    );
  }

  return (
    <UserPanelLayout>
      <Box sx={{ position: 'relative', minHeight: '100vh' }}>
        <AnimatedDotsBackground />
        <Box sx={{ position: 'relative', zIndex: 1, maxWidth: 1200, mx: 'auto' }}>
          <Stack spacing={3}>
            <Box>
            <Stack direction="row" alignItems="center" spacing={2} sx={{ mb: 1 }}>
              <Box
                sx={{
                  p: 1.5,
                  borderRadius: 2,
                  background: 'linear-gradient(135deg, #1a1a2e 0%, #374151 100%)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 4px 12px rgba(26, 26, 46, 0.4)'
                }}
              >
                <FileText size={24} color="white" />
              </Box>
              <Box>
                <Typography variant="h5" sx={{ fontWeight: 700, background: 'linear-gradient(135deg, #1a1a2e 0%, #374151 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                  Script Creator
                </Typography>
                <Typography variant="body2" sx={{ color: '#64748b' }}>
                  Generate AI-powered storyboards for your videos
                </Typography>
              </Box>
            </Stack>
          </Box>

          <Paper elevation={0} sx={{ p: { xs: 3, md: 4 }, borderRadius: 3, border: '1px solid rgba(0,0,0,0.08)', backgroundColor: '#ffffff' }}>
            <Stack spacing={3}>
              <Box>
                <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600, color: '#374151' }}>
                  What is your story about?
                  <Chip label="Required" size="small" sx={{ ml: 1, height: 20, fontSize: '0.7rem', bgcolor: alpha('#1a1a2e', 0.1), color: '#1a1a2e' }} />
                </Typography>
                <TextField
                  fullWidth
                  multiline
                  rows={3}
                  placeholder="e.g., A young entrepreneur starting a tech company..."
                  value={storyAbout}
                  onChange={(e) => setStoryAbout(e.target.value)}
                  disabled={isGenerating}
                  data-testid="input-story"
                  sx={{ '& .MuiOutlinedInput-root': { borderRadius: 2 } }}
                />
              </Box>

              <Box>
                <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600, color: '#374151' }}>
                  What should be the final step/scene?
                </Typography>
                <TextField
                  fullWidth
                  multiline
                  rows={2}
                  placeholder="e.g., The entrepreneur celebrating the company's IPO..."
                  value={finalStep}
                  onChange={(e) => setFinalStep(e.target.value)}
                  disabled={isGenerating}
                  data-testid="input-final"
                  sx={{ '& .MuiOutlinedInput-root': { borderRadius: 2 } }}
                />
              </Box>

              <Box>
                <Typography variant="subtitle2" sx={{ mb: 2, fontWeight: 600, color: '#374151' }}>
                  Number of Prompts: {numberOfPrompts}
                </Typography>
                <Slider
                  value={numberOfPrompts}
                  onChange={(_, value) => setNumberOfPrompts(value as number)}
                  min={5}
                  max={30}
                  step={1}
                  disabled={isGenerating}
                  sx={{ 
                    color: '#1a1a2e',
                    '& .MuiSlider-thumb': {
                      background: 'linear-gradient(135deg, #1a1a2e 0%, #374151 100%)',
                      '&:hover, &.Mui-focusVisible': {
                        boxShadow: '0 0 0 8px rgba(26, 26, 46, 0.16)'
                      }
                    },
                    '& .MuiSlider-track': {
                      background: 'linear-gradient(135deg, #1a1a2e 0%, #374151 100%)',
                      border: 'none'
                    },
                    '& .MuiSlider-rail': {
                      bgcolor: alpha('#1a1a2e', 0.2)
                    }
                  }}
                />
              </Box>

              <Button
                variant="contained"
                size="large"
                onClick={handleGenerate}
                disabled={isGenerating || !storyAbout.trim() || !finalStep.trim()}
                startIcon={isGenerating ? <CircularProgress size={18} sx={{ color: 'white' }} /> : <Wand2 size={18} />}
                data-testid="button-generate"
                sx={{
                  width: '100%',
                  py: 1.5,
                  borderRadius: 2,
                  textTransform: 'none',
                  fontWeight: 600,
                  fontSize: '1rem',
                  color: 'white',
                  background: 'linear-gradient(135deg, #1a1a2e 0%, #374151 100%)',
                  boxShadow: '0 4px 15px rgba(26, 26, 46, 0.4)',
                  '&:hover': {
                    background: 'linear-gradient(135deg, #0f172a 0%, #1f2937 100%)',
                    boxShadow: '0 6px 20px rgba(26, 26, 46, 0.5)',
                  },
                  '&:disabled': { 
                    background: 'linear-gradient(135deg, rgba(26, 26, 46, 0.5) 0%, rgba(55, 65, 81, 0.5) 100%)',
                    color: 'rgba(255,255,255,0.7)',
                  },
                }}
              >
                {isGenerating ? 'Generating Script...' : 'Generate Script'}
              </Button>
            </Stack>
          </Paper>

          {generatedScript && (
            <Paper elevation={0} sx={{ p: { xs: 3, md: 4 }, borderRadius: 3, border: '1px solid rgba(0,0,0,0.08)', backgroundColor: '#ffffff' }}>
              <Stack spacing={3}>
                <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1}>
                  <Typography variant="h6" sx={{ fontWeight: 600, color: '#1a1a2e' }}>Generated Script</Typography>
                  <Stack direction="row" spacing={1}>
                    <Button variant="outlined" size="small" onClick={handleCopyScript} startIcon={<Copy size={16} />} sx={{ borderRadius: 2, textTransform: 'none', borderColor: '#1a1a2e', color: '#1a1a2e', '&:hover': { borderColor: '#0f172a', background: 'linear-gradient(135deg, rgba(26, 26, 46, 0.08) 0%, rgba(55, 65, 81, 0.08) 100%)' } }}>
                      Copy
                    </Button>
                  </Stack>
                </Stack>

                <Paper elevation={0} sx={{ p: 2, bgcolor: '#f8fafc', borderRadius: 2, maxHeight: 300, overflow: 'auto' }}>
                  <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace', color: '#374151' }}>
                    {generatedScript}
                  </Typography>
                </Paper>
              </Stack>
            </Paper>
          )}
          </Stack>
        </Box>
      </Box>
    </UserPanelLayout>
  );
}
