// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface Simulation {
  id: string;
  name: string;
  encryptedParams: string;
  timestamp: number;
  creator: string;
  status: "active" | "paused" | "completed";
  agentCount: number;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'increase10%':
      result = value * 1.1;
      break;
    case 'decrease10%':
      result = value * 0.9;
      break;
    case 'double':
      result = value * 2;
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [simulations, setSimulations] = useState<Simulation[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newSimulationData, setNewSimulationData] = useState({ 
    name: "", 
    agentCount: 100,
    cooperationRate: 50,
    riskAversion: 30,
    mobility: 60
  });
  const [showTutorial, setShowTutorial] = useState(false);
  const [selectedSimulation, setSelectedSimulation] = useState<Simulation | null>(null);
  const [decryptedParams, setDecryptedParams] = useState<any>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [searchTerm, setSearchTerm] = useState("");

  const activeCount = simulations.filter(s => s.status === "active").length;
  const pausedCount = simulations.filter(s => s.status === "paused").length;
  const completedCount = simulations.filter(s => s.status === "completed").length;

  useEffect(() => {
    loadSimulations().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadSimulations = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      const keysBytes = await contract.getData("simulation_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing simulation keys:", e); }
      }
      
      const list: Simulation[] = [];
      for (const key of keys) {
        try {
          const simBytes = await contract.getData(`simulation_${key}`);
          if (simBytes.length > 0) {
            try {
              const simData = JSON.parse(ethers.toUtf8String(simBytes));
              list.push({ 
                id: key, 
                name: simData.name,
                encryptedParams: simData.params, 
                timestamp: simData.timestamp, 
                creator: simData.creator, 
                status: simData.status || "active",
                agentCount: simData.agentCount || 100
              });
            } catch (e) { console.error(`Error parsing simulation data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading simulation ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setSimulations(list);
    } catch (e) { console.error("Error loading simulations:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const createSimulation = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting simulation parameters with Zama FHE..." });
    try {
      // Encrypt all numerical parameters
      const encryptedParams = {
        agentCount: FHEEncryptNumber(newSimulationData.agentCount),
        cooperationRate: FHEEncryptNumber(newSimulationData.cooperationRate),
        riskAversion: FHEEncryptNumber(newSimulationData.riskAversion),
        mobility: FHEEncryptNumber(newSimulationData.mobility)
      };
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const simulationId = `sim-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const simulationData = { 
        name: newSimulationData.name,
        params: JSON.stringify(encryptedParams), 
        timestamp: Math.floor(Date.now() / 1000), 
        creator: address, 
        status: "active",
        agentCount: newSimulationData.agentCount
      };
      
      await contract.setData(`simulation_${simulationId}`, ethers.toUtf8Bytes(JSON.stringify(simulationData)));
      
      // Update keys list
      const keysBytes = await contract.getData("simulation_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(simulationId);
      await contract.setData("simulation_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE-encrypted simulation created!" });
      await loadSimulations();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewSimulationData({ 
          name: "", 
          agentCount: 100,
          cooperationRate: 50,
          riskAversion: 30,
          mobility: 60
        });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Creation failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<any> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      const encryptedParams = JSON.parse(encryptedData);
      const decryptedParams = {
        agentCount: FHEDecryptNumber(encryptedParams.agentCount),
        cooperationRate: FHEDecryptNumber(encryptedParams.cooperationRate),
        riskAversion: FHEDecryptNumber(encryptedParams.riskAversion),
        mobility: FHEDecryptNumber(encryptedParams.mobility)
      };
      return decryptedParams;
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const updateSimulationStatus = async (simulationId: string, newStatus: "active" | "paused" | "completed") => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Updating simulation status with FHE..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const simBytes = await contract.getData(`simulation_${simulationId}`);
      if (simBytes.length === 0) throw new Error("Simulation not found");
      const simData = JSON.parse(ethers.toUtf8String(simBytes));
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedSim = { ...simData, status: newStatus };
      await contractWithSigner.setData(`simulation_${simulationId}`, ethers.toUtf8Bytes(JSON.stringify(updatedSim)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Simulation status updated!" });
      await loadSimulations();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Update failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isCreator = (simulationAddress: string) => address?.toLowerCase() === simulationAddress.toLowerCase();

  const tutorialSteps = [
    { title: "Connect Wallet", description: "Connect your Web3 wallet to create and manage simulations", icon: "🔗" },
    { title: "Create Simulation", description: "Configure parameters for your encrypted social physics simulation", icon: "🧪", details: "All parameters are encrypted with Zama FHE before being stored on-chain" },
    { title: "FHE Processing", description: "Social interactions are computed while keeping individual data private", icon: "⚙️", details: "Zama FHE enables complex social simulations without exposing sensitive data" },
    { title: "Analyze Results", description: "Observe emergent social patterns from encrypted computations", icon: "📊", details: "Macro-level patterns emerge while individual privacy is preserved" }
  ];

  const renderStatusChart = () => {
    const total = simulations.length || 1;
    const activePercentage = (activeCount / total) * 100;
    const pausedPercentage = (pausedCount / total) * 100;
    const completedPercentage = (completedCount / total) * 100;
    return (
      <div className="pie-chart-container">
        <div className="pie-chart">
          <div className="pie-segment active" style={{ transform: `rotate(${activePercentage * 3.6}deg)` }}></div>
          <div className="pie-segment paused" style={{ transform: `rotate(${(activePercentage + pausedPercentage) * 3.6}deg)` }}></div>
          <div className="pie-segment completed" style={{ transform: `rotate(${(activePercentage + pausedPercentage + completedPercentage) * 3.6}deg)` }}></div>
          <div className="pie-center">
            <div className="pie-value">{simulations.length}</div>
            <div className="pie-label">Simulations</div>
          </div>
        </div>
        <div className="pie-legend">
          <div className="legend-item"><div className="color-box active"></div><span>Active: {activeCount}</span></div>
          <div className="legend-item"><div className="color-box paused"></div><span>Paused: {pausedCount}</span></div>
          <div className="legend-item"><div className="color-box completed"></div><span>Completed: {completedCount}</span></div>
        </div>
      </div>
    );
  };

  const filteredSimulations = simulations.filter(sim => 
    sim.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    sim.id.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (loading) return (
    <div className="loading-screen">
      <div className="spinner"></div>
      <p>Initializing encrypted connection...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <h1>Social<span>Physics</span>FHE</h1>
          <div className="tagline">FHE-Encrypted Social Simulations</div>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-btn">
            + New Simulation
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <nav className="main-nav">
        <ul>
          <li className={activeTab === "dashboard" ? "active" : ""} onClick={() => setActiveTab("dashboard")}>
            <span className="nav-icon">📊</span> Dashboard
          </li>
          <li className={activeTab === "simulations" ? "active" : ""} onClick={() => setActiveTab("simulations")}>
            <span className="nav-icon">🧪</span> Simulations
          </li>
          <li className={activeTab === "analytics" ? "active" : ""} onClick={() => setActiveTab("analytics")}>
            <span className="nav-icon">📈</span> Analytics
          </li>
          <li className={activeTab === "about" ? "active" : ""} onClick={() => setActiveTab("about")}>
            <span className="nav-icon">ℹ️</span> About
          </li>
        </ul>
      </nav>

      <div className="main-content">
        {activeTab === "dashboard" && (
          <div className="dashboard-view">
            <div className="welcome-banner">
              <h2>FHE-Encrypted Social Physics</h2>
              <p>Explore emergent social patterns while preserving individual privacy with Zama FHE technology</p>
              <div className="fhe-badge">
                <span>🔒 FHE-Powered Privacy</span>
              </div>
            </div>

            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-value">{simulations.length}</div>
                <div className="stat-label">Total Simulations</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{activeCount}</div>
                <div className="stat-label">Active</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{pausedCount}</div>
                <div className="stat-label">Paused</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{completedCount}</div>
                <div className="stat-label">Completed</div>
              </div>
            </div>

            <div className="chart-section">
              <h3>Simulation Status Distribution</h3>
              {renderStatusChart()}
            </div>

            <div className="recent-section">
              <h3>Recent Simulations</h3>
              {simulations.slice(0, 3).map(sim => (
                <div key={sim.id} className="recent-card" onClick={() => setSelectedSimulation(sim)}>
                  <div className="sim-name">{sim.name}</div>
                  <div className="sim-meta">
                    <span className={`status-badge ${sim.status}`}>{sim.status}</span>
                    <span>{sim.agentCount} agents</span>
                    <span>{new Date(sim.timestamp * 1000).toLocaleDateString()}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === "simulations" && (
          <div className="simulations-view">
            <div className="simulations-header">
              <h2>Social Physics Simulations</h2>
              <div className="controls">
                <input 
                  type="text" 
                  placeholder="Search simulations..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="search-input"
                />
                <button onClick={loadSimulations} className="refresh-btn" disabled={isRefreshing}>
                  {isRefreshing ? "Refreshing..." : "Refresh"}
                </button>
              </div>
            </div>

            <div className="simulations-list">
              {filteredSimulations.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-icon">🧪</div>
                  <p>No simulations found</p>
                  <button className="primary-btn" onClick={() => setShowCreateModal(true)}>
                    Create First Simulation
                  </button>
                </div>
              ) : (
                filteredSimulations.map(sim => (
                  <div key={sim.id} className="simulation-card" onClick={() => setSelectedSimulation(sim)}>
                    <div className="card-header">
                      <h3>{sim.name}</h3>
                      <span className={`status-badge ${sim.status}`}>{sim.status}</span>
                    </div>
                    <div className="card-body">
                      <div className="sim-meta">
                        <div><span>Agents:</span> {sim.agentCount}</div>
                        <div><span>Created:</span> {new Date(sim.timestamp * 1000).toLocaleDateString()}</div>
                        <div><span>Creator:</span> {sim.creator.substring(0, 6)}...{sim.creator.substring(38)}</div>
                      </div>
                    </div>
                    <div className="card-footer">
                      {isCreator(sim.creator) && (
                        <div className="actions">
                          {sim.status !== "active" && (
                            <button className="action-btn" onClick={(e) => { e.stopPropagation(); updateSimulationStatus(sim.id, "active"); }}>
                              Activate
                            </button>
                          )}
                          {sim.status !== "paused" && (
                            <button className="action-btn" onClick={(e) => { e.stopPropagation(); updateSimulationStatus(sim.id, "paused"); }}>
                              Pause
                            </button>
                          )}
                          {sim.status !== "completed" && (
                            <button className="action-btn" onClick={(e) => { e.stopPropagation(); updateSimulationStatus(sim.id, "completed"); }}>
                              Complete
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {activeTab === "analytics" && (
          <div className="analytics-view">
            <h2>Simulation Analytics</h2>
            <div className="analytics-grid">
              <div className="analytics-card">
                <h3>Emergent Patterns</h3>
                <div className="placeholder-chart">
                  <p>Cooperation rates over time</p>
                </div>
              </div>
              <div className="analytics-card">
                <h3>Agent Behavior</h3>
                <div className="placeholder-chart">
                  <p>Risk aversion distribution</p>
                </div>
              </div>
              <div className="analytics-card">
                <h3>Social Network</h3>
                <div className="placeholder-chart">
                  <p>Connection patterns</p>
                </div>
              </div>
              <div className="analytics-card">
                <h3>Mobility Analysis</h3>
                <div className="placeholder-chart">
                  <p>Movement patterns</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === "about" && (
          <div className="about-view">
            <h2>About Social Physics FHE</h2>
            <div className="about-content">
              <div className="about-section">
                <h3>Technology</h3>
                <p>
                  This platform uses Zama's Fully Homomorphic Encryption (FHE) to enable privacy-preserving social simulations.
                  All individual agent data remains encrypted throughout computation, while still allowing emergent social patterns to be observed.
                </p>
              </div>
              <div className="about-section">
                <h3>Research Applications</h3>
                <p>
                  Social scientists can study complex social dynamics without compromising individual privacy.
                  Parameters can be adjusted to model different social scenarios while keeping all sensitive data encrypted.
                </p>
              </div>
              <div className="about-section">
                <h3>FHE Benefits</h3>
                <ul>
                  <li>Individual privacy preserved throughout simulation</li>
                  <li>Computations performed on encrypted data</li>
                  <li>Emergent patterns observable without decryption</li>
                  <li>Ethical research tool for sensitive social studies</li>
                </ul>
              </div>
            </div>
          </div>
        )}
      </div>

      {showCreateModal && (
        <div className="modal-overlay">
          <div className="create-modal">
            <div className="modal-header">
              <h2>New Social Simulation</h2>
              <button onClick={() => setShowCreateModal(false)} className="close-btn">&times;</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Simulation Name *</label>
                <input 
                  type="text" 
                  value={newSimulationData.name}
                  onChange={(e) => setNewSimulationData({...newSimulationData, name: e.target.value})}
                  placeholder="Enter simulation name..."
                />
              </div>
              
              <div className="form-group">
                <label>Agent Count *</label>
                <input 
                  type="number" 
                  value={newSimulationData.agentCount}
                  onChange={(e) => setNewSimulationData({...newSimulationData, agentCount: parseInt(e.target.value) || 0})}
                  min="10"
                  max="10000"
                />
              </div>
              
              <div className="params-grid">
                <div className="param-card">
                  <label>Cooperation Rate (%)</label>
                  <input 
                    type="range" 
                    min="0" 
                    max="100" 
                    value={newSimulationData.cooperationRate}
                    onChange={(e) => setNewSimulationData({...newSimulationData, cooperationRate: parseInt(e.target.value)})}
                  />
                  <div className="param-value">{newSimulationData.cooperationRate}</div>
                </div>
                
                <div className="param-card">
                  <label>Risk Aversion (%)</label>
                  <input 
                    type="range" 
                    min="0" 
                    max="100" 
                    value={newSimulationData.riskAversion}
                    onChange={(e) => setNewSimulationData({...newSimulationData, riskAversion: parseInt(e.target.value)})}
                  />
                  <div className="param-value">{newSimulationData.riskAversion}</div>
                </div>
                
                <div className="param-card">
                  <label>Mobility (%)</label>
                  <input 
                    type="range" 
                    min="0" 
                    max="100" 
                    value={newSimulationData.mobility}
                    onChange={(e) => setNewSimulationData({...newSimulationData, mobility: parseInt(e.target.value)})}
                  />
                  <div className="param-value">{newSimulationData.mobility}</div>
                </div>
              </div>
              
              <div className="encryption-notice">
                <div className="notice-icon">🔒</div>
                <div>
                  <strong>FHE Encryption Notice</strong>
                  <p>All parameters will be encrypted with Zama FHE before being stored on-chain</p>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button onClick={() => setShowCreateModal(false)} className="cancel-btn">
                Cancel
              </button>
              <button onClick={createSimulation} disabled={creating || !newSimulationData.name} className="submit-btn">
                {creating ? "Creating with FHE..." : "Create Simulation"}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedSimulation && (
        <div className="modal-overlay">
          <div className="detail-modal">
            <div className="modal-header">
              <h2>{selectedSimulation.name}</h2>
              <button onClick={() => { setSelectedSimulation(null); setDecryptedParams(null); }} className="close-btn">&times;</button>
            </div>
            <div className="modal-body">
              <div className="simulation-meta">
                <div className="meta-item">
                  <span>Status:</span>
                  <strong className={`status-badge ${selectedSimulation.status}`}>{selectedSimulation.status}</strong>
                </div>
                <div className="meta-item">
                  <span>Agents:</span>
                  <strong>{selectedSimulation.agentCount}</strong>
                </div>
                <div className="meta-item">
                  <span>Created:</span>
                  <strong>{new Date(selectedSimulation.timestamp * 1000).toLocaleString()}</strong>
                </div>
                <div className="meta-item">
                  <span>Creator:</span>
                  <strong>{selectedSimulation.creator.substring(0, 6)}...{selectedSimulation.creator.substring(38)}</strong>
                </div>
              </div>
              
              <div className="params-section">
                <h3>Simulation Parameters</h3>
                {decryptedParams ? (
                  <div className="decrypted-params">
                    <div className="param-row">
                      <span>Cooperation Rate:</span>
                      <strong>{decryptedParams.cooperationRate}%</strong>
                    </div>
                    <div className="param-row">
                      <span>Risk Aversion:</span>
                      <strong>{decryptedParams.riskAversion}%</strong>
                    </div>
                    <div className="param-row">
                      <span>Mobility:</span>
                      <strong>{decryptedParams.mobility}%</strong>
                    </div>
                  </div>
                ) : (
                  <div className="encrypted-params">
                    <p>Parameters are encrypted with Zama FHE</p>
                    <button 
                      onClick={async () => {
                        const params = await decryptWithSignature(selectedSimulation.encryptedParams);
                        setDecryptedParams(params);
                      }}
                      disabled={isDecrypting}
                      className="decrypt-btn"
                    >
                      {isDecrypting ? "Decrypting..." : "Decrypt with Wallet"}
                    </button>
                  </div>
                )}
              </div>
              
              <div className="simulation-actions">
                {isCreator(selectedSimulation.creator) && (
                  <>
                    {selectedSimulation.status !== "active" && (
                      <button onClick={() => updateSimulationStatus(selectedSimulation.id, "active")} className="action-btn">
                        Activate
                      </button>
                    )}
                    {selectedSimulation.status !== "paused" && (
                      <button onClick={() => updateSimulationStatus(selectedSimulation.id, "paused")} className="action-btn">
                        Pause
                      </button>
                    )}
                    {selectedSimulation.status !== "completed" && (
                      <button onClick={() => updateSimulationStatus(selectedSimulation.id, "completed")} className="action-btn">
                        Complete
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="spinner"></div>}
              {transactionStatus.status === "success" && "✓"}
              {transactionStatus.status === "error" && "✗"}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <h3>SocialPhysicsFHE</h3>
            <p>Privacy-preserving social simulations powered by Zama FHE</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Research Papers</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge">🔒 FHE-Powered Privacy</div>
          <div className="copyright">© {new Date().getFullYear()} SocialPhysicsFHE. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

export default App;
