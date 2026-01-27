import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Play, Pause, Search, Volume2, ChevronLeft, ChevronRight, Mic2, Filter, X, Copy, Check, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const API_BASE_URL = 'https://voice-library.fakcloud.tech/api';
const VOICES_PER_PAGE = 24;

interface Voice {
  voice_id: string;
  name: string;
  description: string;
  preview_url: string;
  category?: string;
  labels?: {
    accent?: string;
    age?: string;
    gender?: string;
    use_case?: string;
    language?: string;
  };
}

// Extract gender from description
function extractGender(description: string): string {
  const desc = description.toLowerCase();
  if (desc.includes('female') || desc.includes('woman') || desc.includes('girl') || desc.includes('she ') || desc.includes('her ')) {
    return 'Female';
  }
  if (desc.includes('male') || desc.includes('man ') || desc.includes('boy') || desc.includes('he ') || desc.includes('his ')) {
    return 'Male';
  }
  return 'Unknown';
}

// Complete list of ElevenLabs supported languages and accents from json2video.com
const SUPPORTED_LANGUAGES = [
  // Main languages (alphabetical as per json2video.com)
  'arabic', 'bulgarian', 'chinese', 'croatian', 'czech', 'danish', 'dutch',
  'english', 'filipino', 'finnish', 'french', 'german', 'greek', 'hindi',
  'hungarian', 'indonesian', 'italian', 'japanese', 'korean', 'malay',
  'polish', 'portuguese', 'romanian', 'russian', 'slovak', 'spanish',
  'swedish', 'tamil', 'turkish', 'ukrainian', 'vietnamese',
  // Accents and regional variations
  'british', 'american', 'australian', 'indian', 'irish', 'scottish', 'canadian',
  'mexican', 'colombian', 'argentinian', 'brazilian', 'castilian',
  'pakistani', 'bengali', 'punjabi', 'urdu', 'marathi', 'telugu', 'kannada', 'malayalam',
  'thai', 'persian', 'hebrew', 'afrikaans', 'swahili', 'nigerian', 'kenyan',
  'austrian', 'swiss', 'belgian', 'norwegian', 'icelandic',
  'latin', 'uruguayan', 'chilean', 'venezuelan', 'peruvian', 'ecuadorian',
  'taiwanese', 'cantonese', 'mandarin', 'singaporean', 'malaysian'
];

// Extract language/accent from description
function extractLanguage(description: string): string {
  const desc = description.toLowerCase();
  for (const lang of SUPPORTED_LANGUAGES) {
    if (desc.includes(lang)) {
      return lang.charAt(0).toUpperCase() + lang.slice(1);
    }
  }
  return 'Other';
}

export default function ElevenLabsVoices() {
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [genderFilter, setGenderFilter] = useState<string>("all");
  const [languageFilter, setLanguageFilter] = useState<string>("all");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const { data: allVoices = [], isLoading, refetch, isFetching } = useQuery<Voice[]>({
    queryKey: ["elevenlabs-voices-all"],
    queryFn: async () => {
      // Use "e" as search query since API requires non-empty query - "e" matches ~4800 voices
      // Limit to 500 for faster loading - most common voices first
      const response = await fetch(`${API_BASE_URL}/search?q=e&limit=500`);
      const json = await response.json();
      if (json.success && json.data) {
        return json.data;
      }
      return [];
    },
    staleTime: 1000 * 60 * 10,
  });

  // Extract unique genders and languages from descriptions
  const uniqueGenders = useMemo(() => {
    const genders = new Set<string>();
    allVoices.forEach(v => {
      const gender = extractGender(v.description || '');
      if (gender !== 'Unknown') genders.add(gender);
    });
    return Array.from(genders).sort();
  }, [allVoices]);

  const uniqueLanguages = useMemo(() => {
    const languages = new Set<string>();
    allVoices.forEach(v => {
      const lang = extractLanguage(v.description || '');
      if (lang !== 'Other') languages.add(lang);
    });
    return Array.from(languages).sort();
  }, [allVoices]);

  const filteredVoices = allVoices.filter((voice) => {
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      const matchesName = voice.name?.toLowerCase().includes(query);
      const matchesDescription = voice.description?.toLowerCase().includes(query);
      const matchesId = voice.voice_id?.toLowerCase().includes(query);
      if (!matchesName && !matchesDescription && !matchesId) {
        return false;
      }
    }
    if (genderFilter !== "all") {
      const voiceGender = extractGender(voice.description || '');
      if (voiceGender.toLowerCase() !== genderFilter.toLowerCase()) {
        return false;
      }
    }
    if (languageFilter !== "all") {
      const voiceLang = extractLanguage(voice.description || '');
      if (voiceLang.toLowerCase() !== languageFilter.toLowerCase()) {
        return false;
      }
    }
    return true;
  });

  const totalPages = Math.ceil(filteredVoices.length / VOICES_PER_PAGE);
  const startIndex = (currentPage - 1) * VOICES_PER_PAGE;
  const paginatedVoices = filteredVoices.slice(startIndex, startIndex + VOICES_PER_PAGE);

  const hasActiveFilters = genderFilter !== "all" || languageFilter !== "all" || searchQuery !== "";

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, genderFilter, languageFilter]);

  const playPreview = useCallback((voice: Voice) => {
    if (playingVoiceId === voice.voice_id) {
      audioRef.current?.pause();
      setPlayingVoiceId(null);
    } else {
      if (audioRef.current) {
        audioRef.current.pause();
      }
      const audio = new Audio(voice.preview_url);
      audioRef.current = audio;
      audio.onended = () => setPlayingVoiceId(null);
      audio.onerror = () => {
        setPlayingVoiceId(null);
        toast({
          title: "Preview Error",
          description: "Could not play the voice preview",
          variant: "destructive",
        });
      };
      audio.play();
      setPlayingVoiceId(voice.voice_id);
    }
  }, [playingVoiceId, toast]);

  const copyVoiceId = (voiceId: string) => {
    navigator.clipboard.writeText(voiceId);
    setCopiedId(voiceId);
    toast({
      title: "Copied!",
      description: "Voice ID copied to clipboard",
    });
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSearchQuery(searchInput);
  };

  const clearFilters = () => {
    setSearchQuery("");
    setSearchInput("");
    setGenderFilter("all");
    setLanguageFilter("all");
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 via-white to-blue-50 dark:from-gray-900 dark:via-gray-800 dark:to-gray-900">
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-3 mb-4">
            <div className="p-3 bg-gradient-to-br from-purple-500 to-blue-600 rounded-2xl shadow-lg">
              <Mic2 className="w-8 h-8 text-white" />
            </div>
            <h1 className="text-4xl font-bold bg-gradient-to-r from-purple-600 to-blue-600 bg-clip-text text-transparent" data-testid="text-page-title">
              ElevenLabs Voice Library
            </h1>
          </div>
          <p className="text-gray-600 dark:text-gray-400 text-lg max-w-2xl mx-auto">
            Explore over 4,600 professional AI voices for your projects. Search, preview, and find the perfect voice.
          </p>
          <Badge variant="secondary" className="mt-4">
            {allVoices.length.toLocaleString()} Voices Available
          </Badge>
        </div>

        <Card className="mb-8 border-0 shadow-xl bg-white/80 dark:bg-gray-800/80 backdrop-blur-sm">
          <CardContent className="p-6">
            <form onSubmit={handleSearch} className="flex gap-3 mb-6">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <Input
                  type="text"
                  placeholder="Search by name, description, ID..."
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  className="pl-10 h-12 text-lg border-2 focus:border-purple-500"
                  data-testid="input-search-voices"
                />
              </div>
              <Button type="submit" size="lg" className="px-8 bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700" data-testid="button-search">
                {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Search className="w-5 h-5" />}
              </Button>
            </form>

            <div className="flex flex-wrap gap-4 items-center">
              <div className="flex items-center gap-2">
                <Filter className="w-4 h-4 text-gray-500" />
                <span className="text-sm font-medium text-gray-600 dark:text-gray-400">Filters:</span>
              </div>

              <Select value={genderFilter} onValueChange={setGenderFilter}>
                <SelectTrigger className="w-[140px]" data-testid="select-gender">
                  <SelectValue placeholder="Gender" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Genders</SelectItem>
                  {uniqueGenders.map((gender) => (
                    <SelectItem key={gender} value={gender.toLowerCase()}>{gender}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={languageFilter} onValueChange={setLanguageFilter}>
                <SelectTrigger className="w-[160px]" data-testid="select-language">
                  <SelectValue placeholder="Language" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Languages</SelectItem>
                  {uniqueLanguages.map((language) => (
                    <SelectItem key={language} value={language.toLowerCase()}>{language}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {hasActiveFilters && (
                <Button variant="ghost" size="sm" onClick={clearFilters} className="text-red-500 hover:text-red-600" data-testid="button-clear-filters">
                  <X className="w-4 h-4 mr-1" />
                  Clear All
                </Button>
              )}

              <div className="ml-auto text-sm text-gray-500">
                Showing {filteredVoices.length.toLocaleString()} voices
              </div>
            </div>
          </CardContent>
        </Card>

        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-20">
            <Loader2 className="w-12 h-12 animate-spin text-purple-600 mb-4" />
            <p className="text-gray-600 dark:text-gray-400 text-lg">Loading voices...</p>
          </div>
        ) : paginatedVoices.length === 0 ? (
          <Card className="border-0 shadow-lg">
            <CardContent className="py-16 text-center">
              <Volume2 className="w-16 h-16 mx-auto text-gray-300 mb-4" />
              <h3 className="text-xl font-semibold text-gray-600 mb-2">No voices found</h3>
              <p className="text-gray-500 mb-4">Try adjusting your search or filters</p>
              <Button variant="outline" onClick={clearFilters} data-testid="button-reset-search">
                <RefreshCw className="w-4 h-4 mr-2" />
                Reset Search
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5 mb-8">
              {paginatedVoices.map((voice) => (
                <Card 
                  key={voice.voice_id} 
                  className="group border-0 shadow-md hover:shadow-xl transition-all duration-300 bg-white dark:bg-gray-800 overflow-hidden"
                  data-testid={`card-voice-${voice.voice_id}`}
                >
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between gap-2 mb-3">
                      <h3 className="font-bold text-gray-900 dark:text-white truncate flex-1" title={voice.name}>
                        {voice.name}
                      </h3>
                      <Button
                        size="icon"
                        variant={playingVoiceId === voice.voice_id ? "default" : "outline"}
                        className={`shrink-0 w-10 h-10 rounded-full transition-all ${
                          playingVoiceId === voice.voice_id 
                            ? "bg-gradient-to-r from-purple-600 to-blue-600 border-0" 
                            : "hover:border-purple-500 hover:text-purple-600"
                        }`}
                        onClick={() => playPreview(voice)}
                        data-testid={`button-preview-${voice.voice_id}`}
                      >
                        {playingVoiceId === voice.voice_id ? (
                          <Pause className="w-4 h-4" />
                        ) : (
                          <Play className="w-4 h-4 ml-0.5" />
                        )}
                      </Button>
                    </div>

                    <div className="flex flex-wrap gap-1.5 mb-3">
                      {(() => {
                        const gender = extractGender(voice.description || '');
                        const language = extractLanguage(voice.description || '');
                        return (
                          <>
                            {gender !== 'Unknown' && (
                              <Badge variant="secondary" className="text-xs bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300">
                                {gender}
                              </Badge>
                            )}
                            {language !== 'Other' && (
                              <Badge variant="secondary" className="text-xs bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300">
                                {language}
                              </Badge>
                            )}
                          </>
                        );
                      })()}
                    </div>

                    <p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-2 mb-4 min-h-[2.5rem]">
                      {voice.description || "No description available"}
                    </p>

                    <div className="flex items-center gap-2 pt-3 border-t border-gray-100 dark:border-gray-700">
                      <code className="flex-1 text-xs bg-gray-100 dark:bg-gray-700 px-2 py-1.5 rounded truncate font-mono text-gray-600 dark:text-gray-400">
                        {voice.voice_id}
                      </code>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="shrink-0 w-8 h-8"
                        onClick={() => copyVoiceId(voice.voice_id)}
                        data-testid={`button-copy-${voice.voice_id}`}
                      >
                        {copiedId === voice.voice_id ? (
                          <Check className="w-4 h-4 text-green-500" />
                        ) : (
                          <Copy className="w-4 h-4" />
                        )}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-4">
                <Button
                  variant="outline"
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="gap-2"
                  data-testid="button-prev-page"
                >
                  <ChevronLeft className="w-4 h-4" />
                  Previous
                </Button>

                <div className="flex items-center gap-2">
                  {currentPage > 3 && (
                    <>
                      <Button variant="ghost" size="sm" onClick={() => setCurrentPage(1)}>1</Button>
                      {currentPage > 4 && <span className="text-gray-400">...</span>}
                    </>
                  )}
                  
                  {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                    let pageNum;
                    if (totalPages <= 5) {
                      pageNum = i + 1;
                    } else if (currentPage <= 3) {
                      pageNum = i + 1;
                    } else if (currentPage >= totalPages - 2) {
                      pageNum = totalPages - 4 + i;
                    } else {
                      pageNum = currentPage - 2 + i;
                    }
                    
                    if (pageNum < 1 || pageNum > totalPages) return null;
                    
                    return (
                      <Button
                        key={pageNum}
                        variant={currentPage === pageNum ? "default" : "ghost"}
                        size="sm"
                        onClick={() => setCurrentPage(pageNum)}
                        className={currentPage === pageNum ? "bg-gradient-to-r from-purple-600 to-blue-600" : ""}
                        data-testid={`button-page-${pageNum}`}
                      >
                        {pageNum}
                      </Button>
                    );
                  })}

                  {currentPage < totalPages - 2 && (
                    <>
                      {currentPage < totalPages - 3 && <span className="text-gray-400">...</span>}
                      <Button variant="ghost" size="sm" onClick={() => setCurrentPage(totalPages)}>{totalPages}</Button>
                    </>
                  )}
                </div>

                <Button
                  variant="outline"
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="gap-2"
                  data-testid="button-next-page"
                >
                  Next
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            )}

            <div className="text-center mt-6 text-sm text-gray-500">
              Page {currentPage} of {totalPages} ({filteredVoices.length.toLocaleString()} total voices)
            </div>
          </>
        )}
      </div>
    </div>
  );
}
