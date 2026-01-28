import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader2, Search, Play, Users, Eye, ThumbsUp, Calendar, Tag, Shield, CheckCircle, XCircle, ExternalLink, Youtube, TrendingUp, Zap, BarChart3, Filter, Sparkles, ArrowRight, Heart, MessageCircle, Film } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import UserPanelLayout from "@/layouts/UserPanelLayout";

const API_BASE = "https://youtube.fakcloud.tech";

interface VideoData {
  scan_status: string;
  videoId: string;
  I_Identity: {
    title: string;
    views: string;
    likes_exact: string;
    publish_date: string;
    category: string;
  };
  II_Monetization_Analysis: {
    monetization_confidence: string;
    is_monetized: boolean;
    verdict: string;
    verification_checklist: string[];
  };
  III_Technical: {
    is_family_safe: string;
    is_crawlable: string;
    codecs: string[];
  };
  IV_Recommendations: Array<{
    id: string;
    title: string;
    thumbnail: string;
    channel?: { name: string };
  }>;
  V_Heatmap: Array<{ time: string; intensity: number }> | string;
}

interface ChannelData {
  scan_status: string;
  channelId: string;
  name: string;
  handle: string;
  subscribers: string;
  total_videos: string;
  total_views: string;
  description: string;
  avatar: string;
  banner: string;
  joined_date: string;
  country: string;
  recent_videos: Array<{
    id: string;
    title: string;
    thumbnail: string;
    views: string;
    published: string;
  }>;
}

interface SearchResult {
  results: Array<{
    type: string;
    id: string;
    title: string;
    thumbnail: string;
    channel?: { name: string; id: string };
    views?: string;
    published?: string;
    duration?: string;
    subscribers?: string;
    video_count?: string;
  }>;
}

export default function DeepYTAnalyze() {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [videoData, setVideoData] = useState<VideoData | null>(null);
  const [channelData, setChannelData] = useState<ChannelData | null>(null);
  const [searchData, setSearchData] = useState<SearchResult | null>(null);
  const [sortBy, setSortBy] = useState("relevance");
  const [filterType, setFilterType] = useState("all");
  const [filterDuration, setFilterDuration] = useState("any");
  const [isSearchActive, setIsSearchActive] = useState(false);
  const { toast } = useToast();

  const hasResults = videoData || channelData || searchData;

  const clearResults = () => {
    setVideoData(null);
    setChannelData(null);
    setSearchData(null);
  };

  const analyze = async (forcedQuery?: string) => {
    const query = forcedQuery || input.trim();
    if (!query) return;

    clearResults();
    setLoading(true);

    try {
      const isChannel = /youtube\.com\/(?:@|c\/|channel\/|user\/)/.test(query) || query.startsWith('@');
      const isVideo = /youtu\.be\/|watch\?v=|shorts\/|live\/|^[a-zA-Z0-9_-]{11}$/.test(query);

      if (isVideo && !query.includes(' ')) {
        await handleVideo(query);
      } else if (isChannel && !query.includes(' ')) {
        await handleChannel(query);
      } else {
        await handleSearch(query);
      }
    } catch (err: any) {
      toast({
        title: "Error",
        description: err.message || "Failed to analyze",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleVideo = async (urlOrId: string) => {
    // Convert video ID to full URL if needed
    let videoUrl = urlOrId;
    if (/^[a-zA-Z0-9_-]{11}$/.test(urlOrId)) {
      videoUrl = `https://www.youtube.com/watch?v=${urlOrId}`;
    }
    
    const res = await fetch(`${API_BASE}/video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: videoUrl })
    });
    const data = await res.json();
    setVideoData(data);
  };

  const handleChannel = async (url: string) => {
    const res = await fetch(`${API_BASE}/channel?url=${encodeURIComponent(url)}`);
    const raw = await res.json();
    
    // Map API response to our ChannelData format
    const main = raw.MainChannelDetails || {};
    const desc = raw.DescriptionAndBusiness || {};
    
    const mapped: ChannelData = {
      scan_status: "Completed",
      channelId: main.ChannelID || "",
      name: main.Name || "",
      handle: main.Handle || "",
      subscribers: main.Subscribers || "",
      total_videos: main.VideoCount || "",
      total_views: main.TotalViews || "",
      description: desc.FullDescription !== "N/A" ? desc.FullDescription : "",
      avatar: main.LogoURL_Largest || "",
      banner: main.BannerURL_Largest !== "N/A" ? main.BannerURL_Largest : "",
      joined_date: main.JoinedDate?.replace("Joined ", "") || "",
      country: main.Country || "",
      recent_videos: []
    };
    
    setChannelData(mapped);
  };

  const handleSearch = async (q: string) => {
    const params = new URLSearchParams({ 
      q, 
      sort: sortBy, 
      type: filterType, 
      duration: filterDuration 
    });
    const res = await fetch(`${API_BASE}/search?${params.toString()}`);
    const data = await res.json();
    setSearchData(data);
  };

  return (
    <UserPanelLayout>
      <div className="container mx-auto p-6 max-w-6xl relative">
        {/* Decorative Background Elements - Only show when not active */}
        {!isSearchActive && !hasResults && !loading && (
          <>
            {/* Left side decorations */}
            <div className="absolute -left-10 top-10 hidden xl:block">
              <div className="w-48 h-48 bg-gradient-to-br from-red-200 to-rose-100 rounded-full blur-3xl opacity-50 animate-pulse"></div>
              <div className="mt-4 ml-16 space-y-4">
                <div className="flex items-center gap-3 text-muted-foreground/60 animate-[fadeIn_1s_ease-in-out]" style={{animation: 'pulse 3s infinite'}}>
                  <div className="w-10 h-10 rounded-xl bg-red-100 flex items-center justify-center">
                    <Play className="w-5 h-5 text-red-500" />
                  </div>
                  <div>
                    <p className="font-medium text-foreground/70">Videos</p>
                    <p className="text-xs">Deep analysis</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 text-muted-foreground/60" style={{animation: 'pulse 3s infinite 0.5s'}}>
                  <div className="w-10 h-10 rounded-xl bg-purple-100 flex items-center justify-center">
                    <Users className="w-5 h-5 text-purple-500" />
                  </div>
                  <div>
                    <p className="font-medium text-foreground/70">Channels</p>
                    <p className="text-xs">Growth metrics</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 text-muted-foreground/60" style={{animation: 'pulse 3s infinite 1s'}}>
                  <div className="w-10 h-10 rounded-xl bg-blue-100 flex items-center justify-center">
                    <BarChart3 className="w-5 h-5 text-blue-500" />
                  </div>
                  <div>
                    <p className="font-medium text-foreground/70">Analytics</p>
                    <p className="text-xs">Performance data</p>
                  </div>
                </div>
              </div>
            </div>
            
            {/* Right side decorations */}
            <div className="absolute -right-10 top-10 hidden xl:block text-right">
              <div className="w-48 h-48 bg-gradient-to-bl from-purple-200 to-blue-100 rounded-full blur-3xl opacity-50 animate-pulse ml-auto"></div>
              <div className="mt-4 mr-16 space-y-4">
                <div className="flex items-center justify-end gap-3 text-muted-foreground/60" style={{animation: 'pulse 3s infinite 0.3s'}}>
                  <div>
                    <p className="font-medium text-foreground/70">Trending</p>
                    <p className="text-xs">Popular content</p>
                  </div>
                  <div className="w-10 h-10 rounded-xl bg-orange-100 flex items-center justify-center">
                    <TrendingUp className="w-5 h-5 text-orange-500" />
                  </div>
                </div>
                <div className="flex items-center justify-end gap-3 text-muted-foreground/60" style={{animation: 'pulse 3s infinite 0.8s'}}>
                  <div>
                    <p className="font-medium text-foreground/70">Insights</p>
                    <p className="text-xs">Viewer behavior</p>
                  </div>
                  <div className="w-10 h-10 rounded-xl bg-green-100 flex items-center justify-center">
                    <Eye className="w-5 h-5 text-green-500" />
                  </div>
                </div>
                <div className="flex items-center justify-end gap-3 text-muted-foreground/60" style={{animation: 'pulse 3s infinite 1.3s'}}>
                  <div>
                    <p className="font-medium text-foreground/70">Monetization</p>
                    <p className="text-xs">Revenue check</p>
                  </div>
                  <div className="w-10 h-10 rounded-xl bg-yellow-100 flex items-center justify-center">
                    <Zap className="w-5 h-5 text-yellow-600" />
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
        
        {/* Animated Header & Search Section */}
        <div className={`transition-all duration-700 ease-in-out ${!isSearchActive && !hasResults && !loading ? 'min-h-[50vh] flex flex-col justify-center pt-10' : 'pt-0'}`}>
          {/* Header - Centered when not active */}
          <div className={`transition-all duration-500 ease-out ${!isSearchActive && !hasResults && !loading ? 'text-center mb-10' : 'mb-6'}`}>
            <div className={`${!isSearchActive && !hasResults && !loading ? 'text-center' : 'flex items-center gap-3'}`}>
              {(isSearchActive || hasResults || loading) && (
                <div className="bg-gradient-to-br from-red-500 via-red-600 to-rose-600 rounded-xl w-10 h-10 flex items-center justify-center">
                  <Youtube className="text-white w-5 h-5" />
                </div>
              )}
              <h1 className={`font-black tracking-tighter transition-all duration-300 w-full ${!isSearchActive && !hasResults && !loading ? 'text-[2.5rem] sm:text-[3.5rem] md:text-[4.5rem] lg:text-[5.5rem] xl:text-[6rem]' : 'text-2xl'}`} data-testid="text-page-title">
                <span className="bg-gradient-to-r from-gray-900 via-gray-700 to-gray-900 dark:from-white dark:via-gray-200 dark:to-white bg-clip-text text-transparent">Deep YT Search</span>{' '}
                <span className="bg-gradient-to-r from-red-500 to-rose-600 bg-clip-text text-transparent">Analyze</span>
              </h1>
            </div>
            {(!isSearchActive && !hasResults && !loading) && (
              <p className="text-muted-foreground mt-4 text-lg max-w-xl mx-auto">
                Powerful AI-driven YouTube intelligence for videos, channels & content discovery
              </p>
            )}
          </div>

          {/* Professional Search Bar */}
          <div className={`transition-all duration-500 ease-out ${!isSearchActive && !hasResults && !loading ? 'max-w-2xl mx-auto w-full' : ''}`}>
            <div className="relative group">
              <div className={`absolute inset-0 bg-gradient-to-r from-red-500/20 via-purple-500/20 to-blue-500/20 rounded-2xl blur-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 ${isSearchActive || hasResults || loading ? 'hidden' : ''}`}></div>
              <div className={`relative bg-background border-2 rounded-xl shadow-lg transition-all duration-300 ${isSearchActive || hasResults || loading ? 'border-border' : 'border-transparent hover:border-primary/30'}`}>
                <div className="flex flex-col lg:flex-row gap-3 p-4">
                  <div className="flex-1 relative">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
                    <Input
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { setIsSearchActive(true); analyze(); } }}
                      placeholder="Paste Video URL, Channel Link (@handle), or Search keywords..."
                      className="pl-12 h-14 text-lg border-0 bg-muted/50 rounded-lg focus-visible:ring-2 focus-visible:ring-primary/50"
                      data-testid="input-yt-analyze"
                    />
                  </div>
                  <Button 
                    onClick={() => { setIsSearchActive(true); analyze(); }} 
                    disabled={loading}
                    className="h-14 px-8 bg-gradient-to-r from-red-500 to-red-600 hover:from-red-600 hover:to-red-700 text-white rounded-lg font-semibold text-base shadow-lg shadow-red-500/25"
                    data-testid="button-analyze"
                  >
                    {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : (
                      <>
                        <Zap className="w-5 h-5 mr-2" />
                        Analyze
                      </>
                    )}
                  </Button>
                </div>

                {/* Filters - Show only when active or has results */}
                <div className={`overflow-hidden transition-all duration-300 ${isSearchActive || hasResults || loading ? 'max-h-24 opacity-100 px-4 pb-4' : 'max-h-0 opacity-0'}`}>
                  <div className="flex flex-wrap gap-3 pt-2 border-t">
                    <Select value={sortBy} onValueChange={setSortBy}>
                      <SelectTrigger className="w-36 h-9" data-testid="select-sort">
                        <SelectValue placeholder="Sort by" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="relevance">Relevance</SelectItem>
                        <SelectItem value="date">Upload Date</SelectItem>
                        <SelectItem value="views">View Count</SelectItem>
                        <SelectItem value="rating">Rating</SelectItem>
                      </SelectContent>
                    </Select>

                    <Select value={filterType} onValueChange={setFilterType}>
                      <SelectTrigger className="w-36 h-9" data-testid="select-type">
                        <SelectValue placeholder="Type" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Types</SelectItem>
                        <SelectItem value="video">Videos Only</SelectItem>
                        <SelectItem value="channel">Channels Only</SelectItem>
                        <SelectItem value="playlist">Playlists</SelectItem>
                      </SelectContent>
                    </Select>

                    <Select value={filterDuration} onValueChange={setFilterDuration}>
                      <SelectTrigger className="w-36 h-9" data-testid="select-duration">
                        <SelectValue placeholder="Duration" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="any">Any Duration</SelectItem>
                        <SelectItem value="short">Short (&lt; 4m)</SelectItem>
                        <SelectItem value="long">Long (&gt; 20m)</SelectItem>
                      </SelectContent>
                    </Select>

                    <span className="text-xs text-muted-foreground flex items-center gap-2 ml-auto">
                      <span className="w-2 h-2 bg-green-500 rounded-full inline-block animate-pulse"></span>
                      Auto Detection Active
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {loading && (
          <Card className="my-8 overflow-hidden">
            <CardContent className="p-8">
              <div className="flex flex-col items-center">
                {/* Animated Logo */}
                <div className="relative mb-6">
                  <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-red-500 to-rose-600 flex items-center justify-center animate-pulse">
                    <Youtube className="w-10 h-10 text-white" />
                  </div>
                  <div className="absolute -top-1 -right-1 w-6 h-6 bg-green-500 rounded-full flex items-center justify-center">
                    <Loader2 className="w-4 h-4 text-white animate-spin" />
                  </div>
                </div>
                
                {/* Status Text */}
                <h3 className="text-xl font-bold mb-2">Analyzing Content</h3>
                <p className="text-muted-foreground mb-6">Please wait while we fetch data from YouTube...</p>
                
                {/* Progress Steps */}
                <div className="flex items-center gap-3 mb-6">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 bg-green-500 rounded-full animate-pulse"></div>
                    <span className="text-sm text-muted-foreground">Connected</span>
                  </div>
                  <div className="w-8 h-0.5 bg-muted"></div>
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 bg-yellow-500 rounded-full animate-bounce"></div>
                    <span className="text-sm font-medium">Fetching Data</span>
                  </div>
                  <div className="w-8 h-0.5 bg-muted"></div>
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 bg-muted rounded-full"></div>
                    <span className="text-sm text-muted-foreground">Processing</span>
                  </div>
                </div>
                
                {/* Loading Bar */}
                <div className="w-full max-w-md h-2 bg-muted rounded-full overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-red-500 to-rose-600 rounded-full animate-pulse" style={{width: '60%', animation: 'pulse 1s ease-in-out infinite'}}></div>
                </div>
                
                <p className="text-xs text-muted-foreground mt-4">
                  This may take a few seconds depending on the content type...
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {!loading && !hasResults && !isSearchActive && (
          <div className="py-8 mt-8">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-10 items-stretch">
              {/* Video Analysis Card */}
              <div 
                className="group relative cursor-pointer h-full"
                onClick={() => setInput("https://youtube.com/watch?v=")}
              >
                <div className="absolute inset-0 bg-gradient-to-br from-red-500/20 to-rose-500/10 rounded-2xl blur-xl opacity-0 group-hover:opacity-100 transition-all duration-500"></div>
                <Card className="relative overflow-hidden border-2 border-transparent group-hover:border-red-200 dark:group-hover:border-red-900 transition-all duration-300 group-hover:shadow-xl group-hover:shadow-red-500/10 h-full">
                  <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl from-red-100 to-transparent dark:from-red-950/50 rounded-bl-full opacity-50"></div>
                  <CardContent className="p-8 text-center relative h-full flex flex-col">
                    <div className="relative inline-flex mb-6 mx-auto">
                      <div className="w-16 h-16 bg-gradient-to-br from-red-500 to-rose-600 rounded-2xl flex items-center justify-center shadow-lg shadow-red-500/30 group-hover:scale-110 transition-transform duration-300">
                        <Play className="w-8 h-8 text-white" />
                      </div>
                      <div className="absolute -bottom-1 -right-1 w-6 h-6 bg-green-500 rounded-lg flex items-center justify-center shadow-md">
                        <Zap className="w-3 h-3 text-white" />
                      </div>
                    </div>
                    <h3 className="text-lg font-bold mb-3 group-hover:text-red-600 transition-colors">Video Analysis</h3>
                    <p className="text-sm text-muted-foreground leading-relaxed flex-1">
                      Monetization, views, likes & retention heatmap
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2 justify-center">
                      <span className="text-xs px-2 py-1 bg-red-100 dark:bg-red-950 text-red-600 dark:text-red-400 rounded-full">Views</span>
                      <span className="text-xs px-2 py-1 bg-red-100 dark:bg-red-950 text-red-600 dark:text-red-400 rounded-full">Likes</span>
                      <span className="text-xs px-2 py-1 bg-red-100 dark:bg-red-950 text-red-600 dark:text-red-400 rounded-full">Revenue</span>
                    </div>
                  </CardContent>
                </Card>
              </div>
              
              {/* Channel Intelligence Card */}
              <div 
                className="group relative cursor-pointer h-full"
                onClick={() => setInput("@")}
              >
                <div className="absolute inset-0 bg-gradient-to-br from-purple-500/20 to-violet-500/10 rounded-2xl blur-xl opacity-0 group-hover:opacity-100 transition-all duration-500"></div>
                <Card className="relative overflow-hidden border-2 border-transparent group-hover:border-purple-200 dark:group-hover:border-purple-900 transition-all duration-300 group-hover:shadow-xl group-hover:shadow-purple-500/10 h-full">
                  <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl from-purple-100 to-transparent dark:from-purple-950/50 rounded-bl-full opacity-50"></div>
                  <CardContent className="p-8 text-center relative h-full flex flex-col">
                    <div className="relative inline-flex mb-6 mx-auto">
                      <div className="w-16 h-16 bg-gradient-to-br from-purple-500 to-violet-600 rounded-2xl flex items-center justify-center shadow-lg shadow-purple-500/30 group-hover:scale-110 transition-transform duration-300">
                        <Users className="w-8 h-8 text-white" />
                      </div>
                      <div className="absolute -bottom-1 -right-1 w-6 h-6 bg-blue-500 rounded-lg flex items-center justify-center shadow-md">
                        <TrendingUp className="w-3 h-3 text-white" />
                      </div>
                    </div>
                    <h3 className="text-lg font-bold mb-3 group-hover:text-purple-600 transition-colors">Channel Intelligence</h3>
                    <p className="text-sm text-muted-foreground leading-relaxed flex-1">
                      Subscribers, videos & channel growth metrics
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2 justify-center">
                      <span className="text-xs px-2 py-1 bg-purple-100 dark:bg-purple-950 text-purple-600 dark:text-purple-400 rounded-full">Subs</span>
                      <span className="text-xs px-2 py-1 bg-purple-100 dark:bg-purple-950 text-purple-600 dark:text-purple-400 rounded-full">Videos</span>
                      <span className="text-xs px-2 py-1 bg-purple-100 dark:bg-purple-950 text-purple-600 dark:text-purple-400 rounded-full">Growth</span>
                    </div>
                  </CardContent>
                </Card>
              </div>
              
              {/* SERP Search Card */}
              <div 
                className="group relative cursor-pointer h-full"
                onClick={() => setInput("")}
              >
                <div className="absolute inset-0 bg-gradient-to-br from-blue-500/20 to-cyan-500/10 rounded-2xl blur-xl opacity-0 group-hover:opacity-100 transition-all duration-500"></div>
                <Card className="relative overflow-hidden border-2 border-transparent group-hover:border-blue-200 dark:group-hover:border-blue-900 transition-all duration-300 group-hover:shadow-xl group-hover:shadow-blue-500/10 h-full">
                  <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl from-blue-100 to-transparent dark:from-blue-950/50 rounded-bl-full opacity-50"></div>
                  <CardContent className="p-8 text-center relative h-full flex flex-col">
                    <div className="relative inline-flex mb-6 mx-auto">
                      <div className="w-16 h-16 bg-gradient-to-br from-blue-500 to-cyan-600 rounded-2xl flex items-center justify-center shadow-lg shadow-blue-500/30 group-hover:scale-110 transition-transform duration-300">
                        <Search className="w-8 h-8 text-white" />
                      </div>
                      <div className="absolute -bottom-1 -right-1 w-6 h-6 bg-orange-500 rounded-lg flex items-center justify-center shadow-md">
                        <Filter className="w-3 h-3 text-white" />
                      </div>
                    </div>
                    <h3 className="text-lg font-bold mb-3 group-hover:text-blue-600 transition-colors">SERP Search</h3>
                    <p className="text-sm text-muted-foreground leading-relaxed flex-1">
                      Search with filters for relevance, type & duration
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2 justify-center">
                      <span className="text-xs px-2 py-1 bg-blue-100 dark:bg-blue-950 text-blue-600 dark:text-blue-400 rounded-full">Filters</span>
                      <span className="text-xs px-2 py-1 bg-blue-100 dark:bg-blue-950 text-blue-600 dark:text-blue-400 rounded-full">Sort</span>
                      <span className="text-xs px-2 py-1 bg-blue-100 dark:bg-blue-950 text-blue-600 dark:text-blue-400 rounded-full">Type</span>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>

            {/* Quick Start Section */}
            <Card className="overflow-hidden border-0 bg-gradient-to-r from-slate-50 via-white to-slate-50 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950">
              <CardContent className="p-8">
                <div className="flex items-center justify-center gap-2 mb-6">
                  <Sparkles className="w-5 h-5 text-yellow-500" />
                  <h3 className="text-lg font-bold">Quick Start Guide</h3>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                  <div className="relative group">
                    <div className="flex items-start gap-4 p-4 rounded-xl bg-background border hover:border-red-200 dark:hover:border-red-800 transition-colors">
                      <div className="w-10 h-10 bg-gradient-to-br from-red-500 to-rose-600 rounded-xl flex items-center justify-center shrink-0 shadow-md">
                        <span className="text-white font-bold">1</span>
                      </div>
                      <div>
                        <p className="font-semibold mb-1">Paste Video URL</p>
                        <p className="text-xs text-muted-foreground">youtube.com/watch?v=...</p>
                      </div>
                    </div>
                    <ArrowRight className="hidden md:block absolute -right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/30" />
                  </div>
                  
                  <div className="relative group">
                    <div className="flex items-start gap-4 p-4 rounded-xl bg-background border hover:border-purple-200 dark:hover:border-purple-800 transition-colors">
                      <div className="w-10 h-10 bg-gradient-to-br from-purple-500 to-violet-600 rounded-xl flex items-center justify-center shrink-0 shadow-md">
                        <span className="text-white font-bold">2</span>
                      </div>
                      <div>
                        <p className="font-semibold mb-1">Paste Channel URL</p>
                        <p className="text-xs text-muted-foreground">@ChannelName or /c/...</p>
                      </div>
                    </div>
                    <ArrowRight className="hidden md:block absolute -right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/30" />
                  </div>
                  
                  <div className="flex items-start gap-4 p-4 rounded-xl bg-background border hover:border-blue-200 dark:hover:border-blue-800 transition-colors">
                    <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-cyan-600 rounded-xl flex items-center justify-center shrink-0 shadow-md">
                      <span className="text-white font-bold">3</span>
                    </div>
                    <div>
                      <p className="font-semibold mb-1">Enter Keywords</p>
                      <p className="text-xs text-muted-foreground">Search for content</p>
                    </div>
                  </div>
                </div>

                <div className="border-t pt-6">
                  <p className="text-sm text-center text-muted-foreground mb-4">Try these popular searches:</p>
                  <div className="flex flex-wrap justify-center gap-3">
                    <Button 
                      variant="outline" 
                      className="rounded-full px-5 hover:bg-purple-50 hover:border-purple-300 hover:text-purple-600 dark:hover:bg-purple-950 dark:hover:border-purple-700"
                      onClick={() => { setIsSearchActive(true); setInput("@MrBeast"); analyze("@MrBeast"); }} 
                      data-testid="example-mrbeast"
                    >
                      <Users className="w-4 h-4 mr-2" />
                      @MrBeast
                    </Button>
                    <Button 
                      variant="outline" 
                      className="rounded-full px-5 hover:bg-orange-50 hover:border-orange-300 hover:text-orange-600 dark:hover:bg-orange-950 dark:hover:border-orange-700"
                      onClick={() => { setIsSearchActive(true); setInput("trending music 2026"); analyze("trending music 2026"); }} 
                      data-testid="example-trending"
                    >
                      <TrendingUp className="w-4 h-4 mr-2" />
                      trending music 2026
                    </Button>
                    <Button 
                      variant="outline" 
                      className="rounded-full px-5 hover:bg-green-50 hover:border-green-300 hover:text-green-600 dark:hover:bg-green-950 dark:hover:border-green-700"
                      onClick={() => { setIsSearchActive(true); setInput("how to make money"); analyze("how to make money"); }} 
                      data-testid="example-money"
                    >
                      <Zap className="w-4 h-4 mr-2" />
                      how to make money
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {videoData && <VideoResult data={videoData} onAnalyze={analyze} />}
        {channelData && <ChannelResult data={channelData} onAnalyze={analyze} />}
        {searchData && <SearchResults data={searchData} onAnalyze={analyze} />}
      </div>
    </UserPanelLayout>
  );
}

function VideoResult({ data, onAnalyze }: { data: VideoData; onAnalyze: (q: string) => void }) {
  const { I_Identity: ident, II_Monetization_Analysis: mon, III_Technical: tech, IV_Recommendations: recs } = data;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        <Card className="lg:col-span-3">
          <CardContent className="p-6">
            <div className="flex justify-between items-start mb-4">
              <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">{data.scan_status}</Badge>
              <span className="font-mono text-xs text-muted-foreground">ID: {data.videoId}</span>
            </div>
            <h2 className="text-xl font-bold mb-6">{ident.title}</h2>
            
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-muted/50 rounded-lg p-3">
                <p className="text-xs text-muted-foreground flex items-center gap-1 mb-1">
                  <Eye className="w-3 h-3" /> Total Views
                </p>
                <p className="text-lg font-bold">{ident.views}</p>
              </div>
              <div className="bg-muted/50 rounded-lg p-3">
                <p className="text-xs text-muted-foreground flex items-center gap-1 mb-1">
                  <ThumbsUp className="w-3 h-3" /> Likes
                </p>
                <p className="text-lg font-bold">{ident.likes_exact}</p>
              </div>
              <div className="bg-muted/50 rounded-lg p-3">
                <p className="text-xs text-muted-foreground flex items-center gap-1 mb-1">
                  <Calendar className="w-3 h-3" /> Published
                </p>
                <p className="text-lg font-bold">{ident.publish_date}</p>
              </div>
              <div className="bg-muted/50 rounded-lg p-3">
                <p className="text-xs text-muted-foreground flex items-center gap-1 mb-1">
                  <Tag className="w-3 h-3" /> Category
                </p>
                <p className="text-lg font-bold">{ident.category}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-green-200 bg-green-50/50">
          <CardContent className="p-6 flex flex-col justify-center text-center h-full">
            <p className="text-xs font-medium text-muted-foreground uppercase mb-2">Monetization</p>
            <div className="text-2xl font-black mb-1">{mon.monetization_confidence}</div>
            <div className={`font-bold text-sm mb-4 ${mon.is_monetized ? 'text-green-600' : 'text-red-600'}`}>
              {mon.verdict}
            </div>
            <div className="text-left space-y-2">
              {mon.verification_checklist?.map((c, i) => (
                <div key={i} className="text-xs border-b pb-1 flex items-center gap-2">
                  <CheckCircle className="w-3 h-3 text-green-500" /> {c}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Shield className="w-4 h-4" /> Technical Details
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3 font-mono text-xs">
              <div className="bg-muted/50 p-3 rounded-lg">
                <p className="text-muted-foreground">FAMILY SAFE</p>
                <p className="font-bold flex items-center gap-1">
                  {tech.is_family_safe === "Yes" ? <CheckCircle className="w-4 h-4 text-green-500" /> : <XCircle className="w-4 h-4 text-red-500" />}
                  {tech.is_family_safe}
                </p>
              </div>
              <div className="bg-muted/50 p-3 rounded-lg">
                <p className="text-muted-foreground">CRAWLABLE</p>
                <p className="font-bold flex items-center gap-1">
                  {tech.is_crawlable === "Yes" ? <CheckCircle className="w-4 h-4 text-green-500" /> : <XCircle className="w-4 h-4 text-red-500" />}
                  {tech.is_crawlable}
                </p>
              </div>
              <div className="bg-muted/50 p-3 rounded-lg col-span-2">
                <p className="text-muted-foreground">CODECS</p>
                <p className="font-bold truncate">{tech.codecs?.join(' • ')}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Audience Retention Heatmap</CardTitle>
          </CardHeader>
          <CardContent>
            {data.V_Heatmap !== "Not Available" && Array.isArray(data.V_Heatmap) ? (
              <div className="h-32 flex items-end gap-1">
                {data.V_Heatmap.slice(0, 50).map((h, i) => (
                  <div 
                    key={i} 
                    className="flex-1 bg-primary rounded-t"
                    style={{ height: `${h.intensity}%` }}
                    title={`${h.time}: ${h.intensity}%`}
                  />
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground text-center py-8">Heatmap data not available</p>
            )}
          </CardContent>
        </Card>
      </div>

      {recs && recs.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Recommended by YouTube</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
              {recs.map((r, i) => (
                <div 
                  key={i} 
                  className="cursor-pointer group"
                  onClick={() => onAnalyze(r.id)}
                  data-testid={`rec-video-${i}`}
                >
                  <div className="aspect-video bg-muted rounded mb-2 overflow-hidden">
                    <img 
                      src={r.thumbnail} 
                      alt={r.title}
                      className="w-full h-full object-cover group-hover:scale-105 transition"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground truncate">{r.channel?.name}</p>
                  <p className="text-xs font-medium leading-tight line-clamp-2">{r.title}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ChannelResult({ data, onAnalyze }: { data: ChannelData; onAnalyze: (q: string) => void }) {
  return (
    <div className="space-y-8">
      {/* Channel Header with Stats Bar */}
      <Card className="overflow-hidden">
        <CardContent className="p-6">
          <div className="flex items-center justify-between">
            {/* Left: Avatar + Name */}
            <div className="flex items-center gap-4">
              {data.avatar ? (
                <img src={data.avatar} alt={data.name} className="w-14 h-14 rounded-full border-2 border-border" />
              ) : (
                <div className="w-14 h-14 rounded-full bg-muted flex items-center justify-center text-xl font-bold">
                  {data.name?.charAt(0) || "?"}
                </div>
              )}
              <div>
                <h2 className="text-xl font-bold">{data.name}</h2>
                <p className="text-sm text-primary">{data.subscribers} Subscribers</p>
              </div>
            </div>
            
            {/* Right: Stats */}
            <div className="flex items-center gap-8">
              <div className="text-center">
                <div className="flex items-center gap-1 text-2xl font-bold">
                  0% <Zap className="w-5 h-5 text-yellow-500" />
                </div>
                <p className="text-xs text-muted-foreground">Engagement Rate</p>
              </div>
              <div className="text-center">
                <div className="flex items-center gap-1 text-2xl font-bold">
                  {data.total_views} <Heart className="w-5 h-5 text-pink-500" />
                </div>
                <p className="text-xs text-muted-foreground">Total Views</p>
              </div>
              <div className="text-center">
                <div className="flex items-center gap-1 text-2xl font-bold">
                  {data.total_videos} <MessageCircle className="w-5 h-5 text-blue-500" />
                </div>
                <p className="text-xs text-muted-foreground">Total Videos</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Analysis Section */}
      <div>
        <h3 className="text-xl font-bold text-center mb-6">Analysis</h3>
        <div className="space-y-4">
          {/* Content Row */}
          <Card>
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-purple-100 flex items-center justify-center">
                    <Film className="w-5 h-5 text-purple-600" />
                  </div>
                  <span className="font-semibold">Content</span>
                </div>
                <div className="flex items-center gap-12">
                  <div className="text-center">
                    <p className="text-2xl font-bold">{data.total_videos || "0"}</p>
                    <p className="text-xs text-primary">Total Videos</p>
                  </div>
                  <div className="text-center">
                    <p className="text-2xl font-bold">--</p>
                    <p className="text-xs text-primary">Avg Videos/Day</p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Engagement Row */}
          <Card>
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-yellow-100 flex items-center justify-center">
                    <ThumbsUp className="w-5 h-5 text-yellow-600" />
                  </div>
                  <span className="font-semibold">Engagement</span>
                </div>
                <div className="flex items-center gap-12">
                  <div className="text-center">
                    <p className="text-2xl font-bold">--</p>
                    <p className="text-xs text-primary">Total Engagement</p>
                  </div>
                  <div className="text-center">
                    <p className="text-2xl font-bold">--</p>
                    <p className="text-xs text-primary">Avg. Engagement</p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Views Row */}
          <Card>
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-teal-100 flex items-center justify-center">
                    <Eye className="w-5 h-5 text-teal-600" />
                  </div>
                  <span className="font-semibold">Views</span>
                </div>
                <div className="flex items-center gap-12">
                  <div className="text-center">
                    <p className="text-2xl font-bold">{data.total_views || "0"}</p>
                    <p className="text-xs text-primary">Total Views</p>
                  </div>
                  <div className="text-center">
                    <p className="text-2xl font-bold">--</p>
                    <p className="text-xs text-primary">Avg. Views</p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
        <p className="text-xs text-muted-foreground text-center mt-4">*This analysis only takes into consideration data for the last 30 days.</p>
      </div>

      {/* Top Performing Posts */}
      {data.recent_videos && data.recent_videos.length > 0 && (
        <div>
          <h3 className="text-xl font-bold text-center mb-6">Top Performing Posts</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {data.recent_videos.slice(0, 3).map((v, i) => (
              <Card 
                key={i} 
                className="cursor-pointer hover-elevate overflow-hidden"
                onClick={() => onAnalyze(v.id)}
                data-testid={`channel-video-${i}`}
              >
                <CardContent className="p-4">
                  {/* Phone Frame Header */}
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      {data.avatar ? (
                        <img src={data.avatar} alt={data.name} className="w-6 h-6 rounded-full" />
                      ) : (
                        <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-bold">
                          {data.name?.charAt(0)}
                        </div>
                      )}
                      <span className="text-sm font-medium">{data.name}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">Video</Badge>
                      <ExternalLink className="w-4 h-4 text-muted-foreground" />
                    </div>
                  </div>
                  
                  {/* Thumbnail */}
                  <div className="aspect-[9/16] bg-muted rounded-lg mb-3 overflow-hidden">
                    <img 
                      src={v.thumbnail} 
                      alt={v.title}
                      className="w-full h-full object-cover"
                    />
                  </div>
                  
                  {/* Description */}
                  <p className="text-sm line-clamp-2 mb-3">
                    {v.title} <span className="text-primary cursor-pointer">see more</span>
                  </p>
                  
                  {/* Footer */}
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">{v.published}</span>
                    <Badge className="bg-primary/10 text-primary hover:bg-primary/20">{data.subscribers}</Badge>
                  </div>
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-xs text-muted-foreground">Eng. Rate</span>
                    <span className="text-xs font-medium">--</span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Helper to safely render values that might be objects with label/numeric keys
function safeRender(val: any): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'object') {
    if (val.label) return String(val.label);
    if (val.text) return String(val.text);
    return JSON.stringify(val);
  }
  return String(val);
}

function SearchResults({ data, onAnalyze }: { data: SearchResult; onAnalyze: (q: string) => void }) {
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold">Search Results ({data.results?.length || 0})</h2>
      
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {data.results?.map((item, i) => (
          <Card 
            key={i} 
            className="cursor-pointer hover:shadow-md transition-shadow"
            onClick={() => onAnalyze(item.id)}
            data-testid={`search-result-${i}`}
          >
            <CardContent className="p-4">
              <div className="aspect-video bg-muted rounded mb-3 overflow-hidden relative">
                <img 
                  src={safeRender(item.thumbnail)}
                  alt={safeRender(item.title)}
                  className="w-full h-full object-cover"
                />
                {item.duration && (
                  <Badge variant="secondary" className="absolute bottom-2 right-2">{safeRender(item.duration)}</Badge>
                )}
                <Badge variant="outline" className="absolute top-2 left-2 bg-background">{safeRender(item.type)}</Badge>
              </div>
              <h3 className="font-medium text-sm line-clamp-2 mb-1">{safeRender(item.title)}</h3>
              {item.channel && (
                <p className="text-xs text-muted-foreground">{safeRender(item.channel?.name)}</p>
              )}
              <div className="flex gap-2 mt-2 text-xs text-muted-foreground">
                {item.views && <span>{safeRender(item.views)}</span>}
                {item.published && <span>• {safeRender(item.published)}</span>}
                {item.subscribers && <span>{safeRender(item.subscribers)} subscribers</span>}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
