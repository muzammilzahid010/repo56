import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader2, Search, Play, Users, Eye, ThumbsUp, Calendar, Tag, Shield, CheckCircle, XCircle, ExternalLink } from "lucide-react";
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
  const { toast } = useToast();

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
      <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 p-6">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-8">
            <h1 className="text-4xl font-extrabold tracking-tight mb-2">
              <span className="text-black">DEEP YT</span>
              <span className="text-gray-400"> SEARCH ANALYZE</span>
            </h1>
            <p className="text-sm text-gray-500 uppercase tracking-widest">Global Intelligence System</p>
          </div>

        <Card className="mb-8 border-2 border-black shadow-lg">
          <CardContent className="p-6">
            <div className="flex flex-col md:flex-row gap-3">
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && analyze()}
                placeholder="Paste Video URL, Channel Link (@handle), or Search keywords..."
                className="flex-1 text-lg h-14 border-2 border-gray-300 focus:border-black"
                data-testid="input-yt-analyze"
              />
              <Button 
                onClick={() => analyze()} 
                disabled={loading}
                className="h-14 px-10 bg-black hover:bg-gray-800 text-white font-bold text-lg"
                data-testid="button-analyze"
              >
                {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : "ANALYZE"}
              </Button>
            </div>

            <div className="flex flex-wrap gap-4 mt-4">
              <Select value={sortBy} onValueChange={setSortBy}>
                <SelectTrigger className="w-40" data-testid="select-sort">
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
                <SelectTrigger className="w-40" data-testid="select-type">
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
                <SelectTrigger className="w-40" data-testid="select-duration">
                  <SelectValue placeholder="Duration" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any Duration</SelectItem>
                  <SelectItem value="short">Short (&lt; 4m)</SelectItem>
                  <SelectItem value="long">Long (&gt; 20m)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <p className="text-xs text-gray-400 mt-3 font-semibold uppercase">
              Auto Detection: Link → Deep Scan | Keywords → SERP Intelligence
            </p>
          </CardContent>
        </Card>

          {loading && (
            <div className="py-20 text-center">
              <Loader2 className="w-12 h-12 animate-spin mx-auto mb-4 text-black" />
              <p className="font-mono text-sm tracking-widest uppercase animate-pulse">
                Establishing Connection to YouTube Edge Nodes...
              </p>
            </div>
          )}

          {videoData && <VideoResult data={videoData} onAnalyze={analyze} />}
          {channelData && <ChannelResult data={channelData} onAnalyze={analyze} />}
          {searchData && <SearchResults data={searchData} onAnalyze={analyze} />}
        </div>
      </div>
    </UserPanelLayout>
  );
}

function VideoResult({ data, onAnalyze }: { data: VideoData; onAnalyze: (q: string) => void }) {
  const { I_Identity: ident, II_Monetization_Analysis: mon, III_Technical: tech, IV_Recommendations: recs } = data;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        <Card className="lg:col-span-3 border-2 hover:border-black transition-all">
          <CardContent className="p-8">
            <div className="flex justify-between items-start mb-6">
              <Badge className="bg-green-100 text-green-700">{data.scan_status}</Badge>
              <span className="font-mono text-xs text-gray-400">ID: {data.videoId}</span>
            </div>
            <h1 className="text-3xl font-extrabold mb-8 tracking-tight">{ident.title}</h1>
            
            <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
              <div>
                <p className="text-xs font-bold text-gray-400 uppercase flex items-center gap-1">
                  <Eye className="w-3 h-3" /> Total Views
                </p>
                <p className="text-xl font-bold">{ident.views}</p>
              </div>
              <div>
                <p className="text-xs font-bold text-gray-400 uppercase flex items-center gap-1">
                  <ThumbsUp className="w-3 h-3" /> Exact Likes
                </p>
                <p className="text-xl font-bold">{ident.likes_exact}</p>
              </div>
              <div>
                <p className="text-xs font-bold text-gray-400 uppercase flex items-center gap-1">
                  <Calendar className="w-3 h-3" /> Publish Date
                </p>
                <p className="text-xl font-bold">{ident.publish_date}</p>
              </div>
              <div>
                <p className="text-xs font-bold text-gray-400 uppercase flex items-center gap-1">
                  <Tag className="w-3 h-3" /> Category
                </p>
                <p className="text-xl font-bold">{ident.category}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-2 hover:border-black transition-all">
          <CardContent className="p-8 flex flex-col justify-center text-center h-full">
            <p className="text-xs font-bold text-gray-400 uppercase mb-2">Monetization Verdict</p>
            <div className="text-3xl font-black mb-1">{mon.monetization_confidence}</div>
            <div className={`font-bold text-sm mb-6 ${mon.is_monetized ? 'text-green-600' : 'text-red-600'}`}>
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

        <Card className="lg:col-span-2 border-2 hover:border-black transition-all">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="w-5 h-5" /> Technical Deep-Dive
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 font-mono text-xs">
              <div className="bg-gray-50 p-4 rounded">
                <p className="text-gray-400">FAMILY SAFE</p>
                <p className="font-bold flex items-center gap-1">
                  {tech.is_family_safe === "Yes" ? <CheckCircle className="w-4 h-4 text-green-500" /> : <XCircle className="w-4 h-4 text-red-500" />}
                  {tech.is_family_safe}
                </p>
              </div>
              <div className="bg-gray-50 p-4 rounded">
                <p className="text-gray-400">CRAWLABLE</p>
                <p className="font-bold flex items-center gap-1">
                  {tech.is_crawlable === "Yes" ? <CheckCircle className="w-4 h-4 text-green-500" /> : <XCircle className="w-4 h-4 text-red-500" />}
                  {tech.is_crawlable}
                </p>
              </div>
              <div className="bg-gray-50 p-4 rounded col-span-2">
                <p className="text-gray-400">CODECS DETECTED</p>
                <p className="font-bold truncate">{tech.codecs?.join(' • ')}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2 border-2 hover:border-black transition-all">
          <CardHeader>
            <CardTitle>Audience Retention Heatmap</CardTitle>
          </CardHeader>
          <CardContent>
            {data.V_Heatmap !== "Not Available" && Array.isArray(data.V_Heatmap) ? (
              <div className="h-32 flex items-end gap-1">
                {data.V_Heatmap.slice(0, 50).map((h, i) => (
                  <div 
                    key={i} 
                    className="flex-1 bg-black rounded-t"
                    style={{ height: `${h.intensity}%` }}
                    title={`${h.time}: ${h.intensity}%`}
                  />
                ))}
              </div>
            ) : (
              <p className="text-gray-400 text-center py-8">Heatmap data not available</p>
            )}
          </CardContent>
        </Card>
      </div>

      {recs && recs.length > 0 && (
        <Card className="border-2 hover:border-black transition-all">
          <CardHeader>
            <CardTitle className="italic">Algorithm Seeding: Recommended by YouTube</CardTitle>
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
                  <div className="aspect-video bg-gray-100 rounded mb-2 overflow-hidden border border-gray-200">
                    <img 
                      src={r.thumbnail} 
                      alt={r.title}
                      className="w-full h-full object-cover group-hover:scale-110 transition"
                    />
                  </div>
                  <p className="text-xs font-bold text-gray-400 truncate">{r.channel?.name}</p>
                  <p className="text-xs font-bold leading-tight line-clamp-2">{r.title}</p>
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
      <Card className="border-2 hover:border-black transition-all overflow-hidden">
        {data.banner && (
          <div className="h-48 bg-gray-200">
            <img src={data.banner} alt="Banner" className="w-full h-full object-cover" />
          </div>
        )}
        <CardContent className="p-8">
          <div className="flex items-start gap-6">
            {data.avatar && (
              <img src={data.avatar} alt={data.name} className="w-24 h-24 rounded-full border-4 border-white shadow-lg -mt-12" />
            )}
            <div className="flex-1">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h1 className="text-3xl font-extrabold">{data.name}</h1>
                  <p className="text-gray-500">{data.handle}</p>
                </div>
                <Badge className="bg-green-100 text-green-700">{data.scan_status}</Badge>
              </div>
              
              <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-6">
                <div>
                  <p className="text-xs font-bold text-gray-400 uppercase flex items-center gap-1">
                    <Users className="w-3 h-3" /> Subscribers
                  </p>
                  <p className="text-xl font-bold">{data.subscribers}</p>
                </div>
                <div>
                  <p className="text-xs font-bold text-gray-400 uppercase flex items-center gap-1">
                    <Play className="w-3 h-3" /> Total Videos
                  </p>
                  <p className="text-xl font-bold">{data.total_videos}</p>
                </div>
                <div>
                  <p className="text-xs font-bold text-gray-400 uppercase flex items-center gap-1">
                    <Eye className="w-3 h-3" /> Total Views
                  </p>
                  <p className="text-xl font-bold">{data.total_views}</p>
                </div>
                <div>
                  <p className="text-xs font-bold text-gray-400 uppercase flex items-center gap-1">
                    <Calendar className="w-3 h-3" /> Joined
                  </p>
                  <p className="text-xl font-bold">{data.joined_date}</p>
                </div>
              </div>

              {data.description && (
                <p className="text-gray-600 text-sm line-clamp-3">{data.description}</p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {data.recent_videos && data.recent_videos.length > 0 && (
        <Card className="border-2 hover:border-black transition-all">
          <CardHeader>
            <CardTitle>Recent Videos</CardTitle>
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
                  <div className="aspect-video bg-gray-100 rounded mb-2 overflow-hidden border border-gray-200">
                    <img 
                      src={v.thumbnail} 
                      alt={v.title}
                      className="w-full h-full object-cover group-hover:scale-110 transition"
                    />
                  </div>
                  <p className="text-xs font-bold leading-tight line-clamp-2">{v.title}</p>
                  <p className="text-xs text-gray-400">{v.views} • {v.published}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function SearchResults({ data, onAnalyze }: { data: SearchResult; onAnalyze: (q: string) => void }) {
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">Search Results ({data.results?.length || 0})</h2>
      
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {data.results?.map((item, i) => (
          <Card 
            key={i} 
            className="border-2 hover:border-black transition-all cursor-pointer"
            onClick={() => onAnalyze(item.id)}
            data-testid={`search-result-${i}`}
          >
            <CardContent className="p-4">
              <div className="aspect-video bg-gray-100 rounded mb-3 overflow-hidden relative">
                <img 
                  src={item.thumbnail} 
                  alt={item.title}
                  className="w-full h-full object-cover"
                />
                {item.duration && (
                  <Badge className="absolute bottom-2 right-2 bg-black text-white">{item.duration}</Badge>
                )}
                <Badge className="absolute top-2 left-2 bg-white text-black">{item.type}</Badge>
              </div>
              <h3 className="font-bold text-sm line-clamp-2 mb-1">{item.title}</h3>
              {item.channel && (
                <p className="text-xs text-gray-500">{item.channel.name}</p>
              )}
              <div className="flex gap-2 mt-2 text-xs text-gray-400">
                {item.views && <span>{item.views}</span>}
                {item.published && <span>• {item.published}</span>}
                {item.subscribers && <span>{item.subscribers} subscribers</span>}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
