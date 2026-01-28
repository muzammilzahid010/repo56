import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader2, Search, Play, Users, Eye, ThumbsUp, Calendar, Tag, Shield, CheckCircle, XCircle, ExternalLink, Youtube, TrendingUp, Zap, BarChart3 } from "lucide-react";
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

  const handleVideo = async (url: string) => {
    const res = await fetch(`${API_BASE}/video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    setVideoData(data);
  };

  const handleChannel = async (url: string) => {
    const res = await fetch(`${API_BASE}/channel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    setChannelData(data);
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
      <div className="container mx-auto p-6 max-w-6xl">
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
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
              <Card className="text-center p-6 hover:shadow-lg transition-shadow cursor-pointer" onClick={() => setInput("https://youtube.com/watch?v=")}>
                <div className="w-14 h-14 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Play className="w-7 h-7 text-red-500" />
                </div>
                <h3 className="font-bold mb-2">Video Analysis</h3>
                <p className="text-sm text-muted-foreground">
                  Get monetization status, views, likes, audience retention heatmap & technical details
                </p>
              </Card>
              
              <Card className="text-center p-6 hover:shadow-lg transition-shadow cursor-pointer" onClick={() => setInput("@")}>
                <div className="w-14 h-14 bg-purple-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Users className="w-7 h-7 text-purple-500" />
                </div>
                <h3 className="font-bold mb-2">Channel Intelligence</h3>
                <p className="text-sm text-muted-foreground">
                  Analyze subscribers, total videos, views, recent uploads & channel growth metrics
                </p>
              </Card>
              
              <Card className="text-center p-6 hover:shadow-lg transition-shadow cursor-pointer" onClick={() => setInput("")}>
                <div className="w-14 h-14 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Search className="w-7 h-7 text-blue-500" />
                </div>
                <h3 className="font-bold mb-2">SERP Search</h3>
                <p className="text-sm text-muted-foreground">
                  Search YouTube with filters for relevance, date, views, type & duration
                </p>
              </Card>
            </div>

            <Card className="bg-muted/30 border-dashed">
              <CardContent className="p-6 text-center">
                <h3 className="text-base font-bold mb-4">Quick Start</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-left text-sm">
                  <div className="flex gap-3">
                    <div className="w-7 h-7 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-xs font-bold shrink-0">1</div>
                    <div>
                      <p className="font-medium">Paste Video URL</p>
                      <p className="text-xs text-muted-foreground">youtube.com/watch?v=...</p>
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <div className="w-7 h-7 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-xs font-bold shrink-0">2</div>
                    <div>
                      <p className="font-medium">Paste Channel URL</p>
                      <p className="text-xs text-muted-foreground">@ChannelName or /c/...</p>
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <div className="w-7 h-7 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-xs font-bold shrink-0">3</div>
                    <div>
                      <p className="font-medium">Enter Keywords</p>
                      <p className="text-xs text-muted-foreground">Search for content</p>
                    </div>
                  </div>
                </div>

                <div className="mt-4 pt-4 border-t">
                  <p className="text-xs text-muted-foreground mb-2">Quick Examples:</p>
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => { setIsSearchActive(true); setInput("@MrBeast"); analyze("@MrBeast"); }} data-testid="example-mrbeast">
                      @MrBeast
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => { setIsSearchActive(true); setInput("trending music 2026"); analyze("trending music 2026"); }} data-testid="example-trending">
                      trending music 2026
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => { setIsSearchActive(true); setInput("how to make money"); analyze("how to make money"); }} data-testid="example-money">
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
    <div className="space-y-6">
      <Card className="overflow-hidden">
        {data.banner && (
          <div className="h-40 bg-muted">
            <img src={data.banner} alt="Banner" className="w-full h-full object-cover" />
          </div>
        )}
        <CardContent className="p-6">
          <div className="flex items-start gap-4">
            {data.avatar && (
              <img src={data.avatar} alt={data.name} className="w-20 h-20 rounded-full border-4 border-background shadow-lg -mt-12" />
            )}
            <div className="flex-1">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h2 className="text-2xl font-bold">{data.name}</h2>
                  <p className="text-muted-foreground">{data.handle}</p>
                </div>
                <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">{data.scan_status}</Badge>
              </div>
              
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                <div className="bg-muted/50 rounded-lg p-3">
                  <p className="text-xs text-muted-foreground flex items-center gap-1 mb-1">
                    <Users className="w-3 h-3" /> Subscribers
                  </p>
                  <p className="text-lg font-bold">{data.subscribers}</p>
                </div>
                <div className="bg-muted/50 rounded-lg p-3">
                  <p className="text-xs text-muted-foreground flex items-center gap-1 mb-1">
                    <Play className="w-3 h-3" /> Total Videos
                  </p>
                  <p className="text-lg font-bold">{data.total_videos}</p>
                </div>
                <div className="bg-muted/50 rounded-lg p-3">
                  <p className="text-xs text-muted-foreground flex items-center gap-1 mb-1">
                    <Eye className="w-3 h-3" /> Total Views
                  </p>
                  <p className="text-lg font-bold">{data.total_views}</p>
                </div>
                <div className="bg-muted/50 rounded-lg p-3">
                  <p className="text-xs text-muted-foreground flex items-center gap-1 mb-1">
                    <Calendar className="w-3 h-3" /> Joined
                  </p>
                  <p className="text-lg font-bold">{data.joined_date}</p>
                </div>
              </div>

              {data.description && (
                <p className="text-muted-foreground text-sm line-clamp-3">{data.description}</p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {data.recent_videos && data.recent_videos.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Recent Videos</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {data.recent_videos.map((v, i) => (
                <div 
                  key={i} 
                  className="cursor-pointer group"
                  onClick={() => onAnalyze(v.id)}
                  data-testid={`channel-video-${i}`}
                >
                  <div className="aspect-video bg-muted rounded mb-2 overflow-hidden">
                    <img 
                      src={v.thumbnail} 
                      alt={v.title}
                      className="w-full h-full object-cover group-hover:scale-105 transition"
                    />
                  </div>
                  <p className="text-xs font-medium leading-tight line-clamp-2">{v.title}</p>
                  <p className="text-xs text-muted-foreground">{v.views} • {v.published}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
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
