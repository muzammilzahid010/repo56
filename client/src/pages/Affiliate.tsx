import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Copy, Gift, Users, Wallet, Link2, Sparkles, TrendingUp, Star, Banknote, Clock, CheckCircle, XCircle, Loader2, AlertTriangle, Home } from 'lucide-react';
import { Link } from 'wouter';
import { apiRequest, queryClient } from '@/lib/queryClient';

interface User {
  id: string;
  username: string;
  isAdmin: boolean;
  planType?: string;
}

interface SessionData {
  authenticated: boolean;
  user?: User;
}

interface ReferredUser {
  id: string;
  username: string;
  planType: string | null;
  createdAt: string;
}

interface AffiliateInfo {
  uid: string;
  affiliateBalance: number;
  totalReferrals: number;
  earnings: Array<{
    id: number;
    amount: number;
    planType: string;
    referredUserId: string;
    createdAt: string;
    isFirstTime?: boolean;
  }>;
  referredUsers?: {
    free: ReferredUser[];
    scale: ReferredUser[];
    empire: ReferredUser[];
    enterprise: ReferredUser[];
  };
}

interface AffiliateSettings {
  empireEarning: number;
  scaleEarning: number;
  empireRenewalEarning: number;
  scaleRenewalEarning: number;
}

interface Withdrawal {
  id: string;
  userId: string;
  amount: number;
  bankName: string;
  accountNumber: string;
  accountHolderName: string;
  status: 'pending' | 'approved' | 'rejected';
  remarks: string | null;
  requestedAt: string;
  processedAt: string | null;
}

export default function Affiliate() {
  const { toast } = useToast();
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedUid, setCopiedUid] = useState(false);
  const [showWithdrawDialog, setShowWithdrawDialog] = useState(false);
  const [bankName, setBankName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [accountHolderName, setAccountHolderName] = useState('');
  const [expandedCategories, setExpandedCategories] = useState<{ free: boolean; scale: boolean; empire: boolean }>({
    free: false,
    scale: false,
    empire: false,
  });
  const INITIAL_DISPLAY_COUNT = 3;

  const { data: session } = useQuery<SessionData>({
    queryKey: ['/api/session'],
  });

  const { data: affiliateInfo, isLoading: infoLoading } = useQuery<AffiliateInfo>({
    queryKey: ['/api/affiliate/my-info'],
    enabled: !!session?.authenticated,
  });

  const { data: settingsData } = useQuery<{ settings: AffiliateSettings }>({
    queryKey: ['/api/affiliate/settings'],
  });

  const { data: withdrawalsData, refetch: refetchWithdrawals } = useQuery<{ withdrawals: Withdrawal[] }>({
    queryKey: ['/api/affiliate/withdrawals'],
    enabled: !!session?.authenticated,
  });

  const withdrawMutation = useMutation({
    mutationFn: async (data: { bankName: string; accountNumber: string; accountHolderName: string }) => {
      const response = await apiRequest('POST', '/api/affiliate/withdrawals', data);
      return response.json();
    },
    onSuccess: (data) => {
      toast({
        title: 'Withdrawal Request Submitted',
        description: data.message || 'Your withdrawal request has been submitted for review',
      });
      setShowWithdrawDialog(false);
      setBankName('');
      setAccountNumber('');
      setAccountHolderName('');
      queryClient.invalidateQueries({ queryKey: ['/api/affiliate/withdrawals'] });
      queryClient.invalidateQueries({ queryKey: ['/api/affiliate/my-info'] });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Withdrawal Failed',
        description: error.message || 'Failed to submit withdrawal request',
      });
    },
  });

  const handleWithdrawSubmit = () => {
    if (!bankName.trim() || !accountNumber.trim() || !accountHolderName.trim()) {
      toast({
        variant: 'destructive',
        title: 'Missing Information',
        description: 'Please fill in all bank details',
      });
      return;
    }
    withdrawMutation.mutate({ bankName, accountNumber, accountHolderName });
  };

  const MIN_WITHDRAWAL = 1000;
  const canWithdraw = (affiliateInfo?.affiliateBalance || 0) >= MIN_WITHDRAWAL;
  const hasPendingWithdrawal = withdrawalsData?.withdrawals?.some(w => w.status === 'pending') || false;

  const referralLink = affiliateInfo?.uid 
    ? `${window.location.origin}/signup?ref=${affiliateInfo.uid}`
    : '';

  const copyToClipboard = async (text: string, type: 'link' | 'uid') => {
    try {
      await navigator.clipboard.writeText(text);
      if (type === 'link') {
        setCopiedLink(true);
        setTimeout(() => setCopiedLink(false), 2000);
      } else {
        setCopiedUid(true);
        setTimeout(() => setCopiedUid(false), 2000);
      }
      toast({
        title: 'Copied!',
        description: `${type === 'link' ? 'Referral link' : 'Your UID'} copied to clipboard`,
      });
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Failed to copy',
        description: 'Please try again',
      });
    }
  };

  if (!session?.authenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900">
        <Card className="w-full max-w-md mx-4">
          <CardContent className="pt-6 text-center">
            <Gift className="w-12 h-12 mx-auto mb-4 text-purple-500" />
            <h2 className="text-xl font-bold mb-2">Join Our Affiliate Program</h2>
            <p className="text-muted-foreground mb-4">
              Login to access your affiliate dashboard and start earning
            </p>
            <Button onClick={() => window.location.href = '/login'} data-testid="button-login-affiliate">
              Login to Continue
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const empireReward = settingsData?.settings?.empireEarning ?? 300;
  const scaleReward = settingsData?.settings?.scaleEarning ?? 100;
  const empireRenewalReward = settingsData?.settings?.empireRenewalEarning ?? 150;
  const scaleRenewalReward = settingsData?.settings?.scaleRenewalEarning ?? 50;

  return (
    <div className="p-4 md:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex justify-start mb-4">
          <Link href="/">
            <Button variant="outline" className="gap-2" data-testid="button-go-home">
              <Home className="w-4 h-4" />
              Home
            </Button>
          </Link>
        </div>
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-purple-100 text-purple-700 mb-4">
            <Sparkles className="w-4 h-4" />
            <span className="text-sm font-medium">VEO3.pk Partner Program</span>
          </div>
          <h1 className="text-3xl md:text-4xl font-bold text-gray-800 mb-2">
            Affiliate Dashboard
          </h1>
          <p className="text-gray-600 max-w-2xl mx-auto">
            Share your unique referral link and earn rewards when your referrals subscribe
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="bg-gradient-to-br from-purple-500 to-purple-700 border-purple-400 shadow-lg">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-3 rounded-full bg-white/20">
                  <Wallet className="w-6 h-6 text-white" />
                </div>
                <div>
                  <p className="text-sm text-purple-100 font-medium">Total Earnings</p>
                  {infoLoading ? (
                    <Skeleton className="h-8 w-24 bg-purple-400/50" />
                  ) : (
                    <p className="text-2xl font-bold text-white drop-shadow-sm">
                      PKR {affiliateInfo?.affiliateBalance?.toLocaleString() ?? 0}
                    </p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-gradient-to-br from-emerald-500 to-emerald-700 border-emerald-400 shadow-lg">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-3 rounded-full bg-white/20">
                  <Users className="w-6 h-6 text-white" />
                </div>
                <div>
                  <p className="text-sm text-emerald-100 font-medium">Total Referrals</p>
                  {infoLoading ? (
                    <Skeleton className="h-8 w-16 bg-emerald-400/50" />
                  ) : (
                    <p className="text-2xl font-bold text-white drop-shadow-sm">
                      {affiliateInfo?.totalReferrals ?? 0}
                    </p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-gradient-to-br from-amber-500 to-amber-600 border-amber-400 shadow-lg">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-3 rounded-full bg-white/20">
                  <Star className="w-6 h-6 text-white" />
                </div>
                <div>
                  <p className="text-sm text-amber-100 font-medium">Your UID</p>
                  {infoLoading ? (
                    <Skeleton className="h-8 w-28 bg-amber-400/50" />
                  ) : (
                    <p className="text-xl font-mono font-bold text-white drop-shadow-sm">
                      {affiliateInfo?.uid ?? 'N/A'}
                    </p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="bg-white border-gray-200 shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-gray-800">
              <Link2 className="w-5 h-5 text-purple-600" />
              Your Referral Link
            </CardTitle>
            <p className="text-gray-600 text-sm mt-1">
              Share this link with friends to earn commission on their subscriptions
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="flex-1 p-3 bg-gray-100 rounded-lg border border-gray-300 font-mono text-sm text-gray-700 break-all">
                {infoLoading ? (
                  <Skeleton className="h-5 w-full bg-gray-200" />
                ) : (
                  referralLink || 'Loading...'
                )}
              </div>
              <Button
                onClick={() => copyToClipboard(referralLink, 'link')}
                disabled={!referralLink || infoLoading}
                className="shrink-0 bg-purple-600 hover:bg-purple-700"
                data-testid="button-copy-referral-link"
              >
                <Copy className="w-4 h-4 mr-2" />
                {copiedLink ? 'Copied!' : 'Copy Link'}
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => copyToClipboard(affiliateInfo?.uid || '', 'uid')}
                disabled={!affiliateInfo?.uid}
                className="border-gray-300 text-gray-700 hover:bg-gray-100"
                data-testid="button-copy-uid"
              >
                <Copy className="w-3 h-3 mr-1" />
                {copiedUid ? 'Copied!' : 'Copy UID Only'}
              </Button>
              <span className="text-sm text-gray-600">
                Share your UID directly: <span className="font-mono text-purple-600 font-bold">{affiliateInfo?.uid}</span>
              </span>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-green-500 to-emerald-600 border-green-400 shadow-lg">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-white drop-shadow-sm">
              <Banknote className="w-5 h-5 text-white" />
              Withdraw Earnings
            </CardTitle>
            <CardDescription className="text-green-100">
              Minimum balance of PKR {MIN_WITHDRAWAL.toLocaleString()} required
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-green-100">Available Balance</p>
                <p className="text-2xl font-bold text-white">
                  PKR {(affiliateInfo?.affiliateBalance || 0).toLocaleString()}
                </p>
              </div>
              <Button
                onClick={() => setShowWithdrawDialog(true)}
                disabled={!canWithdraw || hasPendingWithdrawal || infoLoading}
                className="bg-white text-green-700 hover:bg-green-50"
                data-testid="button-request-withdrawal"
              >
                <Banknote className="w-4 h-4 mr-2" />
                {hasPendingWithdrawal ? 'Pending Request' : 'Request Withdrawal'}
              </Button>
            </div>
            {!canWithdraw && !hasPendingWithdrawal && (
              <div className="flex items-center gap-2 p-3 bg-white/10 rounded-lg">
                <AlertTriangle className="w-4 h-4 text-yellow-200" />
                <p className="text-sm text-green-100">
                  You need PKR {(MIN_WITHDRAWAL - (affiliateInfo?.affiliateBalance || 0)).toLocaleString()} more to withdraw
                </p>
              </div>
            )}
            {hasPendingWithdrawal && (
              <div className="flex items-center gap-2 p-3 bg-white/10 rounded-lg">
                <Clock className="w-4 h-4 text-yellow-200" />
                <p className="text-sm text-green-100">
                  You have a pending withdrawal request being processed
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {withdrawalsData?.withdrawals && withdrawalsData.withdrawals.length > 0 && (
          <Card className="bg-white border-gray-200 shadow-sm">
            <CardHeader>
              <CardTitle className="text-gray-800 flex items-center gap-2">
                <Clock className="w-5 h-5 text-purple-600" />
                Withdrawal History
              </CardTitle>
              <CardDescription className="text-gray-600">
                Track your withdrawal requests
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {withdrawalsData.withdrawals.map((withdrawal, index) => (
                  <div
                    key={withdrawal.id}
                    className="p-4 bg-gray-50 rounded-lg border border-gray-200"
                    data-testid={`withdrawal-row-${index}`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-3">
                        <div className={`p-2 rounded-full ${
                          withdrawal.status === 'approved' ? 'bg-green-100' :
                          withdrawal.status === 'rejected' ? 'bg-red-100' :
                          'bg-yellow-100'
                        }`}>
                          {withdrawal.status === 'approved' ? (
                            <CheckCircle className="w-4 h-4 text-green-600" />
                          ) : withdrawal.status === 'rejected' ? (
                            <XCircle className="w-4 h-4 text-red-600" />
                          ) : (
                            <Clock className="w-4 h-4 text-yellow-600" />
                          )}
                        </div>
                        <div>
                          <p className="font-medium text-gray-800">
                            PKR {withdrawal.amount.toLocaleString()}
                          </p>
                          <p className="text-xs text-gray-500">
                            {new Date(withdrawal.requestedAt).toLocaleDateString()} - {withdrawal.bankName}
                          </p>
                        </div>
                      </div>
                      <Badge className={
                        withdrawal.status === 'approved' ? 'bg-green-100 text-green-700' :
                        withdrawal.status === 'rejected' ? 'bg-red-100 text-red-700' :
                        'bg-yellow-100 text-yellow-700'
                      }>
                        {withdrawal.status.charAt(0).toUpperCase() + withdrawal.status.slice(1)}
                      </Badge>
                    </div>
                    <div className="text-sm text-gray-600">
                      <p>Account: {withdrawal.accountHolderName} - ****{withdrawal.accountNumber.slice(-4)}</p>
                      {withdrawal.remarks && (
                        <p className="mt-1 text-gray-500">
                          <span className="font-medium">Remarks:</span> {withdrawal.remarks}
                        </p>
                      )}
                      {withdrawal.processedAt && (
                        <p className="text-xs text-gray-400 mt-1">
                          Processed: {new Date(withdrawal.processedAt).toLocaleDateString()}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {affiliateInfo?.referredUsers && (
          <Card className="bg-white border-gray-200 shadow-sm">
            <CardHeader>
              <CardTitle className="text-gray-800 flex items-center gap-2">
                <Users className="w-5 h-5 text-purple-600" />
                Referred Users
              </CardTitle>
              <CardDescription className="text-gray-600">
                Users who signed up using your referral link
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="p-4 rounded-lg bg-gray-100 border border-gray-200">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="font-semibold text-gray-700">Free Users</h4>
                    <Badge className="bg-gray-200 text-gray-700">{affiliateInfo.referredUsers.free.length}</Badge>
                  </div>
                  <div className="space-y-2">
                    {affiliateInfo.referredUsers.free.length === 0 ? (
                      <p className="text-xs text-gray-500 italic">No free users yet</p>
                    ) : (
                      <>
                        {(expandedCategories.free 
                          ? affiliateInfo.referredUsers.free 
                          : affiliateInfo.referredUsers.free.slice(0, INITIAL_DISPLAY_COUNT)
                        ).map((user) => (
                          <div key={user.id} className="flex items-center justify-between text-sm">
                            <span className="text-gray-700 truncate">{user.username}</span>
                            <span className="text-xs text-gray-500">{user.createdAt ? new Date(user.createdAt).toLocaleDateString() : '-'}</span>
                          </div>
                        ))}
                        {affiliateInfo.referredUsers.free.length > INITIAL_DISPLAY_COUNT && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setExpandedCategories(prev => ({ ...prev, free: !prev.free }))}
                            className="w-full mt-2 text-gray-600 hover:text-gray-800 hover:bg-gray-200"
                            data-testid="button-view-more-free"
                          >
                            {expandedCategories.free ? 'View Less' : `View More (${affiliateInfo.referredUsers.free.length - INITIAL_DISPLAY_COUNT} more)`}
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </div>
                
                <div className="p-4 rounded-lg bg-blue-50 border border-blue-200">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="font-semibold text-blue-700">Scale Users</h4>
                    <Badge className="bg-blue-100 text-blue-700">{affiliateInfo.referredUsers.scale.length}</Badge>
                  </div>
                  <div className="space-y-2">
                    {affiliateInfo.referredUsers.scale.length === 0 ? (
                      <p className="text-xs text-blue-500 italic">No Scale users yet</p>
                    ) : (
                      <>
                        {(expandedCategories.scale 
                          ? affiliateInfo.referredUsers.scale 
                          : affiliateInfo.referredUsers.scale.slice(0, INITIAL_DISPLAY_COUNT)
                        ).map((user) => (
                          <div key={user.id} className="flex items-center justify-between text-sm">
                            <span className="text-blue-700 truncate">{user.username}</span>
                            <span className="text-xs text-blue-500">{user.createdAt ? new Date(user.createdAt).toLocaleDateString() : '-'}</span>
                          </div>
                        ))}
                        {affiliateInfo.referredUsers.scale.length > INITIAL_DISPLAY_COUNT && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setExpandedCategories(prev => ({ ...prev, scale: !prev.scale }))}
                            className="w-full mt-2 text-blue-600 hover:text-blue-800 hover:bg-blue-100"
                            data-testid="button-view-more-scale"
                          >
                            {expandedCategories.scale ? 'View Less' : `View More (${affiliateInfo.referredUsers.scale.length - INITIAL_DISPLAY_COUNT} more)`}
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </div>
                
                <div className="p-4 rounded-lg bg-amber-50 border border-amber-200">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="font-semibold text-amber-700">Empire Users</h4>
                    <Badge className="bg-amber-100 text-amber-700">{affiliateInfo.referredUsers.empire.length + (affiliateInfo.referredUsers.enterprise?.length || 0)}</Badge>
                  </div>
                  <div className="space-y-2">
                    {affiliateInfo.referredUsers.empire.length === 0 && affiliateInfo.referredUsers.enterprise.length === 0 ? (
                      <p className="text-xs text-amber-500 italic">No Empire users yet</p>
                    ) : (
                      <>
                        {(() => {
                          const allEmpireUsers = [...affiliateInfo.referredUsers.empire, ...affiliateInfo.referredUsers.enterprise];
                          const displayUsers = expandedCategories.empire ? allEmpireUsers : allEmpireUsers.slice(0, INITIAL_DISPLAY_COUNT);
                          return displayUsers.map((user) => (
                            <div key={user.id} className="flex items-center justify-between text-sm">
                              <span className="text-amber-700 truncate">{user.username}</span>
                              <span className="text-xs text-amber-500">{user.createdAt ? new Date(user.createdAt).toLocaleDateString() : '-'}</span>
                            </div>
                          ));
                        })()}
                        {(affiliateInfo.referredUsers.empire.length + (affiliateInfo.referredUsers.enterprise?.length || 0)) > INITIAL_DISPLAY_COUNT && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setExpandedCategories(prev => ({ ...prev, empire: !prev.empire }))}
                            className="w-full mt-2 text-amber-600 hover:text-amber-800 hover:bg-amber-100"
                            data-testid="button-view-more-empire"
                          >
                            {expandedCategories.empire ? 'View Less' : `View More (${(affiliateInfo.referredUsers.empire.length + (affiliateInfo.referredUsers.enterprise?.length || 0)) - INITIAL_DISPLAY_COUNT} more)`}
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card className="bg-gradient-to-br from-yellow-500 to-orange-500 border-yellow-400 shadow-lg">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg text-white flex items-center gap-2 drop-shadow-sm">
                  <TrendingUp className="w-5 h-5 text-white" />
                  Empire Plan Referral
                </CardTitle>
                <Badge className="bg-white/20 text-white border-white/30">
                  Premium
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-yellow-100 uppercase font-medium">First Purchase</p>
                    <p className="text-2xl font-bold text-white drop-shadow-sm">
                      PKR {empireReward.toLocaleString()}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-yellow-100 uppercase font-medium">Renewal</p>
                    <p className="text-2xl font-bold text-white drop-shadow-sm">
                      PKR {empireRenewalReward.toLocaleString()}
                    </p>
                  </div>
                </div>
                <p className="text-sm text-yellow-100">
                  Earn PKR {empireReward} on first purchase & PKR {empireRenewalReward} on every renewal
                </p>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-gradient-to-br from-blue-500 to-cyan-600 border-blue-400 shadow-lg">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg text-white flex items-center gap-2 drop-shadow-sm">
                  <TrendingUp className="w-5 h-5 text-white" />
                  Scale Plan Referral
                </CardTitle>
                <Badge className="bg-white/20 text-white border-white/30">
                  Standard
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-blue-100 uppercase font-medium">First Purchase</p>
                    <p className="text-2xl font-bold text-white drop-shadow-sm">
                      PKR {scaleReward.toLocaleString()}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-blue-100 uppercase font-medium">Renewal</p>
                    <p className="text-2xl font-bold text-white drop-shadow-sm">
                      PKR {scaleRenewalReward.toLocaleString()}
                    </p>
                  </div>
                </div>
                <p className="text-sm text-blue-100">
                  Earn PKR {scaleReward} on first purchase & PKR {scaleRenewalReward} on every renewal
                </p>
              </div>
            </CardContent>
          </Card>
        </div>

        {affiliateInfo?.earnings && affiliateInfo.earnings.length > 0 && (
          <Card className="bg-white border-gray-200 shadow-sm">
            <CardHeader>
              <CardTitle className="text-gray-800 flex items-center gap-2">
                <Gift className="w-5 h-5 text-purple-600" />
                Recent Earnings
              </CardTitle>
              <p className="text-gray-600 text-sm mt-1">
                Your recent referral rewards
              </p>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {affiliateInfo.earnings.slice(0, 10).map((earning, index) => (
                  <div
                    key={earning.id || index}
                    className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-gray-200"
                    data-testid={`earning-row-${index}`}
                  >
                    <div className="flex items-center gap-3">
                      <div className={`p-2 rounded-full ${
                        earning.planType === 'empire' 
                          ? 'bg-yellow-100' 
                          : 'bg-blue-100'
                      }`}>
                        <Gift className={`w-4 h-4 ${
                          earning.planType === 'empire' 
                            ? 'text-yellow-600' 
                            : 'text-blue-600'
                        }`} />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-gray-800">
                            {earning.planType === 'empire' ? 'Empire' : 'Scale'} Plan
                          </p>
                          <Badge variant="outline" className={`text-xs px-1.5 py-0 ${
                            earning.isFirstTime !== false
                              ? 'border-green-300 text-green-600 bg-green-50'
                              : 'border-purple-300 text-purple-600 bg-purple-50'
                          }`}>
                            {earning.isFirstTime !== false ? 'First Purchase' : 'Renewal'}
                          </Badge>
                        </div>
                        <p className="text-xs text-gray-500">
                          {new Date(earning.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    <Badge 
                      className={`font-mono ${
                        earning.planType === 'empire'
                          ? 'bg-yellow-100 text-yellow-700'
                          : 'bg-blue-100 text-blue-700'
                      }`}
                    >
                      +PKR {earning.amount.toLocaleString()}
                    </Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        <Card className="bg-white border-gray-200 shadow-sm">
          <CardContent className="pt-6">
            <div className="text-center space-y-2">
              <h3 className="text-lg font-semibold text-gray-800">How It Works</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-4">
                <div className="text-center p-4">
                  <div className="w-12 h-12 rounded-full bg-purple-100 flex items-center justify-center mx-auto mb-3">
                    <span className="text-xl font-bold text-purple-600">1</span>
                  </div>
                  <h4 className="font-medium text-gray-800 mb-1">Share Your Link</h4>
                  <p className="text-sm text-gray-600">
                    Copy your unique referral link and share it with friends
                  </p>
                </div>
                <div className="text-center p-4">
                  <div className="w-12 h-12 rounded-full bg-purple-100 flex items-center justify-center mx-auto mb-3">
                    <span className="text-xl font-bold text-purple-600">2</span>
                  </div>
                  <h4 className="font-medium text-gray-800 mb-1">Friend Subscribes</h4>
                  <p className="text-sm text-gray-600">
                    When they sign up and subscribe to a paid plan, you earn
                  </p>
                </div>
                <div className="text-center p-4">
                  <div className="w-12 h-12 rounded-full bg-purple-100 flex items-center justify-center mx-auto mb-3">
                    <span className="text-xl font-bold text-purple-600">3</span>
                  </div>
                  <h4 className="font-medium text-gray-800 mb-1">Get Rewarded</h4>
                  <p className="text-sm text-gray-600">
                    Receive PKR {empireReward} for Empire or PKR {scaleReward} for Scale plans
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Dialog open={showWithdrawDialog} onOpenChange={setShowWithdrawDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Banknote className="w-5 h-5 text-green-600" />
              Request Withdrawal
            </DialogTitle>
            <DialogDescription>
              Enter your bank details to receive PKR {(affiliateInfo?.affiliateBalance || 0).toLocaleString()}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="bankName">Bank Name</Label>
              <Input
                id="bankName"
                placeholder="e.g., JazzCash, EasyPaisa, HBL, MCB"
                value={bankName}
                onChange={(e) => setBankName(e.target.value)}
                data-testid="input-bank-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="accountNumber">Account Number</Label>
              <Input
                id="accountNumber"
                placeholder="Enter your account/mobile number"
                value={accountNumber}
                onChange={(e) => setAccountNumber(e.target.value)}
                data-testid="input-account-number"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="accountHolderName">Account Holder Name</Label>
              <Input
                id="accountHolderName"
                placeholder="Name as per bank records"
                value={accountHolderName}
                onChange={(e) => setAccountHolderName(e.target.value)}
                data-testid="input-account-holder-name"
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setShowWithdrawDialog(false)}
              data-testid="button-cancel-withdrawal"
            >
              Cancel
            </Button>
            <Button
              onClick={handleWithdrawSubmit}
              disabled={withdrawMutation.isPending}
              className="bg-green-600 hover:bg-green-700"
              data-testid="button-submit-withdrawal"
            >
              {withdrawMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Submitting...
                </>
              ) : (
                <>
                  <CheckCircle className="w-4 h-4 mr-2" />
                  Submit Request
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
